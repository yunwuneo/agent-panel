import Foundation
import Observation

@MainActor @Observable final class AppModel {
    var relayURL = UserDefaults.standard.string(forKey: "relayOrigin") ?? "http://localhost:8787"
    var email = UserDefaults.standard.string(forKey: "ownerEmail") ?? ""
    var bootstrapToken = ""
    var recoveryCode = ""
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
    var stats: JSONValue = .null
    var pairingCode = ""
    var pairingExpiresAt: Double?
    var lastSequence: [String: Int] = [:]
    @ObservationIgnored private var replayedSessions: Set<String> = []
    @ObservationIgnored private var loadingHistory: Set<String> = []
    @ObservationIgnored let api = RelayClient()
    @ObservationIgnored let passkeys = PasskeyController()
    @ObservationIgnored private var connectionTask: Task<Void, Never>?
    @ObservationIgnored private var socket: URLSessionWebSocketTask?
    @ObservationIgnored private var waiters: [String: CheckedContinuation<JSONValue, Error>] = [:]
    var currentSession: APSession? { sessions.first { $0.id == selectedSession } }
    var visibleSessions: [APSession] { sessions.filter { selectedDevice == nil || $0.deviceId == selectedDevice }.sorted { $0.updatedAt > $1.updatedAt } }
    var pendingApprovals: [APApproval] { approvals.filter { $0.status == "pending" && $0.expiresAt > Int(Date().timeIntervalSince1970 * 1000) } }

    func restore() async {
        #if DEBUG
        // UI automation supplies credentials from an isolated, normally authenticated
        // test Relay. The server still validates every request; nothing is persisted.
        if let origin = ProcessInfo.processInfo.environment["AGENTPANEL_QA_ORIGIN"], let token = ProcessInfo.processInfo.environment["AGENTPANEL_QA_ACCESS_TOKEN"] {
            relayURL = origin; api.origin = origin; api.accessToken = token
            isAuthenticated = true
            await start()
            selectedSession = sessions.first?.id
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
        connectionTask?.cancel(); connectionTask = nil
        socket?.cancel(with: .normalClosure, reason: nil)
        for waiter in waiters.values { waiter.resume(throwing: ClientError.message("已退出登录")) }
        waiters.removeAll()
        api.clearTokens(); isAuthenticated = false; isConnected = false
        sessions = []; devices = []; events = [:]; approvals = []; selectedSession = nil
        lastSequence = [:]; replayedSessions = []
    }
    func start() async { await reload(); connect() }
    func reload() async {
        do {
            let deviceData = try await api.request("/api/devices")
            devices = try deviceData["devices"].decoded([APDevice].self)
            let sessionData = try await api.request("/api/sessions")
            sessions = try sessionData["sessions"].decoded([APSession].self)
            let approvalData = try await api.request("/api/approvals")
            approvals = (try? approvalData["approvals"].decoded([APApproval].self)) ?? []
            try await subscribe()
        } catch { self.error = error.localizedDescription }
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
        defer { loadingHistory.remove(id) }
        do {
            var cursor = after ?? (replayedSessions.contains(id) ? lastSequence[id] ?? 0 : 0)
            try await subscribe()
            while true {
                let result = try await api.request("/api/sessions/\(id)/events?after=\(cursor)&limit=500")
                let items = try result["events"].decoded([APEnvelope].self)
                for item in items { consume(item) }
                let next = Int(result["nextSeq"].numberValue ?? Double(cursor))
                guard result["hasMore"].boolValue == true, next > cursor else { break }
                cursor = next
            }
            replayedSessions.insert(id)
            if events[id]?.isEmpty != false, let session = sessions.first(where: { $0.id == id }), session.source == "local" {
                let transcript = try await readLocalHistory(session)
                let existing = events[id] ?? []
                events[id] = mergedTimeline(existing, transcript)
            }
        } catch { self.error = error.localizedDescription }
    }
    func readLocalHistory(_ session: APSession) async throws -> [APEnvelope] {
        var before: Int?
        var transcript: [APEnvelope] = []
        while !Task.isCancelled {
            var query: [String: JSONValue] = ["limit": .number(500)]
            if let before { query["before"] = .number(Double(before)) }
            let history = try await command("session.history", device: session.deviceId, session: session.id, payload: query, awaitResult: true)
            let items = try history["events"].decoded([APSessionEvent].self)
            let start = Int(history["before"].numberValue ?? 0)
            let page = try items.enumerated().map { index, item in APEnvelope(v: 1, id: "history:\(session.id):\(start + index)", deviceId: session.deviceId, sessionId: session.id, ts: session.createdAt + start + index, type: "session.event", payload: try .encoded(item)) }
            transcript.insert(contentsOf: page, at: 0)
            guard history["hasMore"].boolValue == true, start > 0, before == nil || start < before! else { break }
            before = start
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
    func decide(_ approval: APApproval, allow: Bool) async {
        await perform {
            _ = try await self.api.request("/api/approvals/\(approval.id)/decision", method: "POST", body: .object(["decision": .string(allow ? "allow" : "deny")]))
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
        do { try await action() } catch { self.error = error.localizedDescription }
    }
}
