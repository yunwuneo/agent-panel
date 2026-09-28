import Foundation
import Observation

/// 会话列表排序方式，保存在本机偏好中。
enum SessionSort: String, CaseIterable, Identifiable {
    case priority, project, recent
    var id: String { rawValue }
    var label: String { ["priority": "按优先级", "project": "按项目", "recent": "按时间倒序"][rawValue]! }
    var symbol: String { ["priority": "flag", "project": "folder", "recent": "clock"][rawValue]! }
}

/// 视图消失导致的任务取消不是用户需要处理的错误。
func isCancellation(_ error: Error) -> Bool { error is CancellationError || (error as? URLError)?.code == .cancelled }

/// 与 `@agentpanel/protocol` 的 isExcludedProject 同口径：按完整路径段匹配，兼容 Windows 分隔符。
func isExcludedProject(_ cwd: String, _ excluded: [String]?) -> Bool {
    func normalized(_ path: String) -> String {
        var value = path.replacingOccurrences(of: "\\", with: "/")
        while value.hasSuffix("/") { value.removeLast() }
        return value
    }
    let path = normalized(cwd)
    return (excluded ?? []).contains { entry in
        let root = normalized(entry)
        return !root.isEmpty && (path == root || path.hasPrefix(root + "/"))
    }
}

@MainActor @Observable final class AppModel {
    var relayURL = UserDefaults.standard.string(forKey: "relayOrigin") ?? "http://localhost:8787"
    var email = UserDefaults.standard.string(forKey: "ownerEmail") ?? ""
    var bootstrapToken = ""
    var recoveryCode = ""
    var password = ""
    var passwordEnabled = false
    var recoveryCodes: [String] = []
    var isAuthenticated = false
    var isRegistered = true
    var isBusy = false
    var isConnected = false
    var error: String?
    var devices: [APDevice] = []
    var sessions: [APSession] = []
    var approvals: [APApproval] = []
    var selectedDevice: String?
    var selectedSession: String?
    var events: [String: [APEnvelope]] = [:]
    var localHistoryLoading: Set<String> = []
    var localHistoryErrors: [String: String] = [:]
    var localHistoryBefore: [String: Int] = [:]
    var stats: JSONValue = .null
    var pairingCode = ""
    var pairingExpiresAt: Double?
    var lastSequence: [String: Int] = [:]
    var sessionSort = SessionSort(rawValue: UserDefaults.standard.string(forKey: "sessionSort") ?? "") ?? .priority {
        didSet { UserDefaults.standard.set(sessionSort.rawValue, forKey: "sessionSort") }
    }
    @ObservationIgnored private var replayedSessions: Set<String> = []
    @ObservationIgnored private var loadingHistory: Set<String> = []
    @ObservationIgnored private var localHistoryLoadedAt: [String: Date] = [:]
    @ObservationIgnored private var localHistoryRetryEarlier: Set<String> = []
    @ObservationIgnored private var historyContext = UUID()
    @ObservationIgnored let api = RelayClient()
    @ObservationIgnored let passkeys = PasskeyController()
    @ObservationIgnored private var connectionTask: Task<Void, Never>?
    @ObservationIgnored private var socket: URLSessionWebSocketTask?
    @ObservationIgnored private var waiters: [String: CheckedContinuation<JSONValue, Error>] = [:]
    var currentSession: APSession? { sessions.first { $0.id == selectedSession } }
    /// Relay 已按设备排除规则过滤列表；实时快照直接合并，这里再按同一规则过滤一次。
    var visibleSessions: [APSession] {
        let excluded = Dictionary(devices.map { ($0.id, $0.excludedProjects ?? []) }, uniquingKeysWith: { a, _ in a })
        return sessions.filter { (selectedDevice == nil || $0.deviceId == selectedDevice) && !isExcludedProject($0.cwd, excluded[$0.deviceId]) }.sorted { $0.updatedAt > $1.updatedAt }
    }
    var pendingApprovals: [APApproval] { approvals.filter { $0.status == "pending" && $0.expiresAt > Int(Date().timeIntervalSince1970 * 1000) } }

    func restore() async {
        #if DEBUG
        // UI automation supplies credentials from an isolated, normally authenticated
        // test Relay. The server still validates every request; nothing is persisted.
        if let origin = ProcessInfo.processInfo.environment["AGENTPANEL_QA_ORIGIN"], let token = ProcessInfo.processInfo.environment["AGENTPANEL_QA_ACCESS_TOKEN"] {
            relayURL = origin; api.origin = origin; api.accessToken = token
            isAuthenticated = true
            await start()
            if ProcessInfo.processInfo.environment["AGENTPANEL_QA_SELECT"] != "0" { selectedSession = sessions.first?.id }
            return
        }
        #endif
        api.origin = relayURL
        if api.refreshToken != nil {
            do { try await api.refresh(); isAuthenticated = true; await start() }
            catch { self.error = error.localizedDescription }
        }
    }
    func inspectServer() async {
        await perform {
            self.api.origin = self.relayURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            let status = try await self.api.request("/api/auth/status", authenticated: false)
            self.isRegistered = status["registered"].boolValue ?? true
            self.passwordEnabled = status["passwordEnabled"].boolValue ?? false
            UserDefaults.standard.set(self.api.origin, forKey: "relayOrigin")
        }
    }
    func login(register: Bool) async {
        await perform {
            self.api.origin = self.relayURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            let mode = register ? "register" : "login"
            var body: [String: JSONValue] = ["email": .string(self.email)]
            if register { body["bootstrapToken"] = .string(self.bootstrapToken) }
            let challenge = try await self.api.request("/api/auth/\(mode)/options", method: "POST", body: .object(body), authenticated: false)
            let credential = try await self.passkeys.perform(options: challenge["options"], register: register)
            let response = try await self.api.request("/api/auth/\(mode)/verify", method: "POST", body: .object(["challengeId": challenge["challengeId"], "response": credential, "native": .bool(true)]), authenticated: false)
            self.api.acceptTokens(response)
            self.recoveryCodes = response["recoveryCodes"].arrayValue?.compactMap(\.stringValue) ?? []
            self.bootstrapToken = ""
            self.isAuthenticated = true
            UserDefaults.standard.set(self.email, forKey: "ownerEmail")
            UserDefaults.standard.set(self.api.origin, forKey: "relayOrigin")
            await self.start()
        }
    }
    /// Password counterpart of `login`/`recover`; `mode` is "login", "register" or "recover".
    func passwordAuth(mode: String) async {
        await perform {
            self.api.origin = self.relayURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            var body: [String: JSONValue] = ["email": .string(self.email), "password": .string(self.password), "native": .bool(true)]
            if mode == "register" { body["bootstrapToken"] = .string(self.bootstrapToken) }
            if mode == "recover" { body["recoveryCode"] = .string(self.recoveryCode) }
            let response = try await self.api.request("/api/auth/password/\(mode)", method: "POST", body: .object(body), authenticated: false)
            self.api.acceptTokens(response)
            self.recoveryCodes = response["recoveryCodes"].arrayValue?.compactMap(\.stringValue) ?? []
            self.bootstrapToken = ""; self.recoveryCode = ""; self.password = ""
            self.isAuthenticated = true
            UserDefaults.standard.set(self.email, forKey: "ownerEmail")
            UserDefaults.standard.set(self.api.origin, forKey: "relayOrigin")
            await self.start()
        }
    }
    func changePassword(current: String, new: String) async -> Bool {
        var changed = false
        await perform {
            var body: [String: JSONValue] = ["password": .string(new)]
            if self.passwordEnabled { body["currentPassword"] = .string(current) }
            _ = try await self.api.request("/api/auth/password", method: "PUT", body: .object(body))
            self.passwordEnabled = true
            changed = true
        }
        return changed
    }
    func recover() async {
        await perform {
            self.api.origin = self.relayURL
            let challenge = try await self.api.request("/api/auth/recovery/options", method: "POST", body: .object(["email": .string(self.email), "recoveryCode": .string(self.recoveryCode)]), authenticated: false)
            let credential = try await self.passkeys.perform(options: challenge["options"], register: true)
            let response = try await self.api.request("/api/auth/register/verify", method: "POST", body: .object(["challengeId": challenge["challengeId"], "response": credential, "native": .bool(true)]), authenticated: false)
            self.api.acceptTokens(response)
            self.recoveryCode = ""
            self.recoveryCodes = response["recoveryCodes"].arrayValue?.compactMap(\.stringValue) ?? []
            self.isAuthenticated = true
            await self.start()
        }
    }
    func logout() async {
        _ = try? await api.request("/api/auth/logout", method: "POST", body: .object(["refreshToken": .string(api.refreshToken ?? "")]))
        disconnect(reason: "已退出登录")
        api.clearTokens()
    }
    /// 断开连接并清空当前 Relay 的数据；不吊销也不删除已保存的登录凭据。
    private func disconnect(reason: String) {
        connectionTask?.cancel(); connectionTask = nil
        socket?.cancel(with: .normalClosure, reason: nil); socket = nil
        for waiter in waiters.values { waiter.resume(throwing: ClientError.message(reason)) }
        waiters.removeAll()
        api.accessToken = nil; isAuthenticated = false; isConnected = false
        sessions = []; devices = []; events = [:]; approvals = []; selectedSession = nil; selectedDevice = nil
        lastSequence = [:]; replayedSessions = []
        historyContext = UUID(); loadingHistory = []; localHistoryLoading = []
        localHistoryErrors = [:]; localHistoryBefore = [:]; localHistoryLoadedAt = [:]; localHistoryRetryEarlier = []
    }
    /// 切换到另一个 Relay。刷新令牌按地址分别保存在钥匙串：新地址已有登录时直接恢复，否则回到登录页。
    /// 旧地址的登录保留，切回时无需重新登录。
    func switchRelay(to value: String) async -> Bool {
        let origin = value.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard origin != api.origin else { return true }
        let probe = RelayClient()
        probe.origin = origin
        let status: JSONValue
        do { status = try await probe.request("/api/auth/status", authenticated: false) }
        catch { self.error = "无法连接新的 Relay：\(error.localizedDescription)"; return false }
        disconnect(reason: "已切换 Relay")
        api.origin = origin; relayURL = origin
        UserDefaults.standard.set(origin, forKey: "relayOrigin")
        isRegistered = status["registered"].boolValue ?? true
        passwordEnabled = status["passwordEnabled"].boolValue ?? false
        if api.refreshToken != nil {
            do { try await api.refresh(); isAuthenticated = true; await start() }
            catch { self.error = "该 Relay 的登录已失效，请重新登录" }
        }
        return true
    }
    /// 修改设备名称或排除的项目文件夹；Relay 按设备保存，所有客户端生效。
    func updateDevice(_ id: String, name: String? = nil, excludedProjects: [String]? = nil) async -> Bool {
        var changed = false
        await perform {
            var body: [String: JSONValue] = [:]
            if let name { body["name"] = .string(name) }
            if let excludedProjects { body["excludedProjects"] = .array(excludedProjects.map(JSONValue.string)) }
            let response = try await self.api.request("/api/devices/\(id)", method: "PATCH", body: .object(body))
            let device = try response["device"].decoded(APDevice.self)
            if let index = self.devices.firstIndex(where: { $0.id == id }) { self.devices[index] = device }
            if excludedProjects != nil {
                let data = try await self.api.request("/api/sessions")
                self.sessions = try data["sessions"].decoded([APSession].self)
            }
            changed = true
        }
        return changed
    }
    func start() async {
        if let me = try? await api.request("/api/auth/me"), let address = me["user"]["email"].stringValue { email = address }
        await reload(); connect()
    }
    func reload() async {
        do {
            let deviceData = try await api.request("/api/devices")
            devices = try deviceData["devices"].decoded([APDevice].self)
            let sessionData = try await api.request("/api/sessions")
            sessions = try sessionData["sessions"].decoded([APSession].self)
            let approvalData = try await api.request("/api/approvals")
            approvals = (try? approvalData["approvals"].decoded([APApproval].self)) ?? []
            try await subscribe()
        } catch where !isCancellation(error) { self.error = error.localizedDescription } catch {}
    }
    func connect() {
        connectionTask?.cancel()
        connectionTask = Task { [weak self] in
            var attempt = 0
            while !Task.isCancelled {
                guard let self, self.isAuthenticated else { break }
                do {
                    let connection = try await self.api.socket()
                    self.socket = connection
                    self.isConnected = true
                    attempt = 0
                    let selected = self.selectedSession
                    let replayAfter = selected.flatMap { self.replayedSessions.contains($0) ? self.lastSequence[$0] : nil } ?? 0
                    try await self.subscribe()
                    if let selected { Task { await self.loadHistory(selected, after: replayAfter) } }
                    while !Task.isCancelled {
                        let message = try await connection.receive()
                        let data: Data
                        switch message { case .data(let value): data = value; case .string(let value): data = Data(value.utf8); @unknown default: continue }
                        self.consume(try JSONDecoder().decode(APEnvelope.self, from: data))
                    }
                } catch {
                    self.isConnected = false
                    if Task.isCancelled { break }
                    attempt = min(attempt + 1, 6)
                    try? await Task.sleep(for: .seconds(min(pow(2, Double(attempt)), 30)))
                }
            }
        }
    }
    func subscribe() async throws {
        guard let socket, isConnected else { return }
        let payload: JSONValue = .object(["deviceIds": .array(devices.map { .string($0.id) }), "sessionIds": .array(selectedSession.map { [.string($0)] } ?? [])])
        try await socket.send(.data(JSONEncoder().encode(EnvelopeFactory.make("subscribe", payload: payload))))
    }
    func consume(_ envelope: APEnvelope) {
        let currentEvent = timelineStateIsCurrent(envelope, lastSequence: envelope.sessionId.flatMap { lastSequence[$0] } ?? 0)
        if envelope.type == "ping" {
            Task { try? await socket?.send(.data(JSONEncoder().encode(EnvelopeFactory.make("pong")))) }
            return
        }
        if envelope.type == "result", let requestId = envelope.payload["requestId"].stringValue, let waiter = waiters.removeValue(forKey: requestId) {
            if envelope.payload["ok"].boolValue == true { waiter.resume(returning: envelope.payload["data"]) }
            else { waiter.resume(throwing: ClientError.message(envelope.payload["error"]["message"].stringValue ?? "设备命令失败")) }
        }
        if envelope.type == "device.status", let device = try? envelope.payload.decoded(APDevice.self) {
            let wasKnown = devices.contains { $0.id == device.id }
            devices.removeAll { $0.id == device.id }; devices.append(device)
            if !wasKnown { Task { try? await subscribe() } }
        }
        if envelope.type == "session.snapshot", let updates = try? envelope.payload["sessions"].decoded([APSession].self) {
            let ids = Set(updates.map(\.id)); sessions.removeAll { ids.contains($0.id) }; sessions.append(contentsOf: updates.filter { $0.excludedReason == nil })
        }
        if currentEvent, envelope.type == "approval.request", let approval = try? envelope.payload.decoded(APApproval.self) {
            approvals.removeAll { $0.id == approval.id }; approvals.append(approval)
            if approval.status == "pending", let index = sessions.firstIndex(where: { $0.id == approval.sessionId }) { sessions[index].status = "waiting" }
        }
        if currentEvent, envelope.type == "approval.decide", let approvalId = envelope.payload["approvalId"].stringValue { approvals.removeAll { $0.id == approvalId } }
        if let sessionId = envelope.sessionId, envelope.type == "session.event" {
            events[sessionId] = mergedTimeline(events[sessionId] ?? [], [envelope])
            if currentEvent, let index = sessions.firstIndex(where: { $0.id == sessionId }) {
                let kind = envelope.payload["kind"].stringValue
                if kind == "turn.start" { sessions[index].status = "running" }
                if kind == "error" { sessions[index].status = "error" }
                if kind == "turn.end" { sessions[index].status = sessions[index].status == "error" ? "error" : "completed" }
                if let usage = try? envelope.payload["usage"].decoded(APUsage.self) { sessions[index].usage = usage }
            }
            if let seq = envelope.seq { lastSequence[sessionId] = max(lastSequence[sessionId] ?? 0, seq) }
        }
        if let sessionId = envelope.sessionId, let seq = envelope.seq { lastSequence[sessionId] = max(lastSequence[sessionId] ?? 0, seq) }
    }
    func loadHistory(_ id: String, after: Int? = nil) async {
        guard loadingHistory.insert(id).inserted else { return }
        let context = historyContext
        defer { if context == historyContext { loadingHistory.remove(id) } }
        do {
            var cursor = after ?? (replayedSessions.contains(id) ? lastSequence[id] ?? 0 : 0)
            try await subscribe()
            while true {
                let result = try await api.request("/api/sessions/\(id)/events?after=\(cursor)&limit=500")
                guard context == historyContext else { return }
                try Task.checkCancellation()
                let items = try result["events"].decoded([APEnvelope].self)
                for item in items { consume(item) }
                let next = Int(result["nextSeq"].numberValue ?? Double(cursor))
                guard result["hasMore"].boolValue == true, next > cursor else { break }
                cursor = next
            }
            replayedSessions.insert(id)
        } catch where !isCancellation(error) {
            if context == historyContext { self.error = error.localizedDescription }
        } catch {}
        guard context == historyContext, !Task.isCancelled, let session = sessions.first(where: { $0.id == id }) else { return }
        await loadLocalHistory(session)
    }
    /// Read the latest device transcript automatically, even when Relay already has some events.
    func loadLocalHistory(_ session: APSession, earlier: Bool = false, force: Bool = false) async {
        let id = session.id
        guard session.source == "local", isConnected, devices.contains(where: { $0.id == session.deviceId && $0.online }) else { return }
        if !earlier, !force, let loaded = localHistoryLoadedAt[id], Date().timeIntervalSince(loaded) < 30 { return }
        let before = earlier ? localHistoryBefore[id] : nil
        if earlier && before == nil { return }
        guard localHistoryLoading.insert(id).inserted else { return }
        let context = historyContext
        localHistoryErrors[id] = nil
        defer { if context == historyContext { localHistoryLoading.remove(id) } }
        do {
            var query: [String: JSONValue] = ["limit": .number(200)]
            if let before { query["before"] = .number(Double(before)) }
            let history = try await command("session.history", device: session.deviceId, session: id, payload: query, awaitResult: true)
            guard context == historyContext else { return }
            try Task.checkCancellation()
            let page = try localHistoryPage(history, session: session, before: before)
            events[id] = mergedTimeline(events[id] ?? [], page.events)
            if earlier || localHistoryLoadedAt[id] == nil {
                localHistoryBefore[id] = page.next
            }
            localHistoryLoadedAt[id] = Date()
            localHistoryRetryEarlier.remove(id)
        } catch where !isCancellation(error) {
            if context == historyContext {
                localHistoryErrors[id] = error.localizedDescription
                if earlier { localHistoryRetryEarlier.insert(id) } else { localHistoryRetryEarlier.remove(id) }
            }
        } catch {}
    }
    func retryLocalHistory(_ session: APSession) async {
        await loadLocalHistory(session, earlier: localHistoryRetryEarlier.contains(session.id), force: true)
    }
    func readLocalHistory(_ session: APSession) async throws -> [APEnvelope] {
        var before: Int?
        var transcript: [APEnvelope] = []
        while !Task.isCancelled {
            var query: [String: JSONValue] = ["limit": .number(500)]
            if let before { query["before"] = .number(Double(before)) }
            let history = try await command("session.history", device: session.deviceId, session: session.id, payload: query, awaitResult: true)
            let page = try localHistoryPage(history, session: session, before: before)
            transcript.insert(contentsOf: page.events, at: 0)
            guard let next = page.next else { break }
            before = next
        }
        return transcript
    }
    func command(_ type: String, device: String, session: String? = nil, payload: [String: JSONValue] = [:], awaitResult: Bool = false) async throws -> JSONValue {
        let message = EnvelopeFactory.make(type, payload: .object(payload), device: device, session: session)
        let id = message.id
        let body = try JSONValue.encoded(message)
        if !awaitResult { return try await api.request("/api/commands", method: "POST", body: body) }
        return try await withCheckedThrowingContinuation { continuation in
            waiters[id] = continuation
            Task { @MainActor in
                do { _ = try await api.request("/api/commands", method: "POST", body: body) }
                catch { waiters.removeValue(forKey: id)?.resume(throwing: error) }
            }
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(25))
                waiters.removeValue(forKey: id)?.resume(throwing: ClientError.message("设备响应超时，请检查连接"))
            }
        }
    }
    /// `answers` 仅用于提问类审批：问题 ID → 所选选项或自定义文本。
    func decide(_ approval: APApproval, allow: Bool, answers: [String: [String]]? = nil) async {
        await perform {
            var body: [String: JSONValue] = ["decision": .string(allow ? "allow" : "deny")]
            if allow, let answers { body["answers"] = .object(answers.mapValues { .array($0.map(JSONValue.string)) }) }
            _ = try await self.api.request("/api/approvals/\(approval.id)/decision", method: "POST", body: .object(body))
            self.approvals.removeAll { $0.id == approval.id }
        }
    }
    func pair() async {
        await perform {
            let response = try await self.api.request("/api/pairing", method: "POST", body: .object([:]))
            self.pairingCode = response["code"].stringValue ?? ""
            self.pairingExpiresAt = response["expiresAt"].numberValue
        }
    }
    func loadStats(device: String = "", agent: String = "", project: String = "", days: Int = 30) async {
        await perform {
            var components = URLComponents()
            var queries = [URLQueryItem(name: "from", value: String(Int(Date().addingTimeInterval(Double(-days) * 86400).timeIntervalSince1970 * 1000))), URLQueryItem(name: "groupBy", value: "day")]
            if !device.isEmpty { queries.append(URLQueryItem(name: "deviceId", value: device)) }
            if !agent.isEmpty { queries.append(URLQueryItem(name: "agent", value: agent)) }
            if !project.isEmpty { queries.append(URLQueryItem(name: "project", value: project)) }
            components.queryItems = queries
            self.stats = try await self.api.request("/api/stats?\(components.percentEncodedQuery ?? "")")
        }
    }
    func perform(_ action: () async throws -> Void) async {
        isBusy = true; error = nil
        defer { isBusy = false }
        do { try await action() } catch where !isCancellation(error) { self.error = error.localizedDescription } catch {}
    }
}
