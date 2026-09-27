import SwiftUI
import Charts
import CoreImage.CIFilterBuiltins

struct NewSessionView: View {
    @Bindable var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var device = ""
    @State private var cwd = ""
    @State private var agent = "codex"
    @State private var agentModel = ""
    @State private var permission = "default"
    @State private var prompt = ""
    @State private var entries: APDirectoryListing?
    @State private var loading = false
    @State private var failure: String?
    var capability: APAgentCapability? { model.devices.first { $0.id == device }?.agents.first { $0.kind == agent } }
    var body: some View {
        NavigationStack {
            Form {
                Section("工作环境") {
                    Picker("设备", selection: $device) { ForEach(model.devices.filter(\.online), id: \.id) { Text($0.name).tag($0.id) } }
                    HStack { TextField("工作目录", text: $cwd); Button("浏览") { browse(cwd.isEmpty ? nil : cwd) }.disabled(device.isEmpty || loading) }
                    if let entries {
                        Button("根目录 / 磁盘") { browse(nil) }
                        if let parent = entries.parent { Button { browse(parent) } label: { Label("上一级", systemImage: "arrow.up") } }
                        ForEach(entries.entries, id: \.path) { entry in Button { cwd = entry.path; browse(entry.path) } label: { Label(entry.name, systemImage: "folder") } }
                        if let recent = entries.recent, !recent.isEmpty { Picker("最近目录", selection: $cwd) { Text("选择目录").tag(cwd); ForEach(recent, id: \.self) { Text($0).tag($0) } } }
                    }
                }
                Section("Agent") {
                    Picker("使用", selection: $agent) { Text("Codex").tag("codex"); Text("Claude Code").tag("claude") }.pickerStyle(.segmented)
                    TextField("模型（留空使用默认）", text: $agentModel)
                    if let choices = capability?.models, !choices.isEmpty { Menu("已安装的模型") { ForEach(choices, id: \.self) { choice in Button(choice) { agentModel = choice } } } }
                    Picker("权限模式", selection: $permission) { Text("逐项审批").tag("default"); Text("允许文件编辑").tag("acceptEdits"); Text("仅规划").tag("plan") }
                    if let message = capability?.authMessage { Text(message).font(.caption).foregroundStyle(.secondary) }
                    if capability?.installed == false { Label("此设备尚未安装所选 Agent", systemImage: "exclamationmark.circle").foregroundStyle(.orange) }
                }
                Section("你想完成什么？") { TextEditor(text: $prompt).frame(minHeight: 140) }
            }
            .formStyle(.grouped)
            .navigationTitle("新的会话")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("开始") { create() }.disabled(device.isEmpty || cwd.isEmpty || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || loading || capability?.installed == false || (capability?.executionAvailable ?? capability?.authenticated) == false) }
            }
        }.frame(minWidth: 340, idealWidth: 560, minHeight: 520)
        .onAppear { device = model.devices.first { $0.id == model.selectedDevice && $0.online }?.id ?? model.devices.first(where: \.online)?.id ?? "" }
        .onChange(of: device) { _, _ in
            entries = nil; cwd = ""; agentModel = ""
            let available = model.devices.first { $0.id == device }?.agents.first { $0.installed && ($0.executionAvailable ?? $0.authenticated) == true }
            agent = available?.kind ?? "codex"
            browse(nil)
        }
        .alert("操作未完成", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) { Button("知道了", role: .cancel) { failure = nil } } message: { Text(failure ?? "") }
    }
    func browse(_ path: String?) {
        guard !device.isEmpty else { return }
        let target = device
        loading = true
        Task {
            defer { loading = false }
            do {
                let result = try await model.command("fs.listDir", device: target, payload: ["path": .string(path ?? "")], awaitResult: true)
                guard device == target else { return }
                entries = try result.decoded(APDirectoryListing.self); cwd = entries?.path ?? path ?? ""
            }
            catch { failure = error.localizedDescription }
        }
    }
    func create() {
        loading = true
        Task {
            defer { loading = false }
            do {
                var payload: [String: JSONValue] = ["agent": .string(agent), "cwd": .string(cwd), "prompt": .string(prompt), "permissionMode": .string(permission)]
                if !agentModel.isEmpty { payload["model"] = .string(agentModel) }
                let response = try await model.command("session.create", device: device, payload: payload)
                model.selectedDevice = device
                model.selectedSession = response["sessionId"].stringValue
                await model.reload()
                dismiss()
            } catch { failure = error.localizedDescription }
        }
    }
}

struct PairingView: View {
    @Bindable var model: AppModel
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                Image(systemName: "display.2").font(.system(size: 40, weight: .light)).foregroundStyle(.blue)
                Text("连接你的设备").font(.title2.bold())
                Text("在需要控制的设备上依次运行以下命令。\n配对后启动 Daemon，保持终端开启，设备才会上线。").multilineTextAlignment(.center).foregroundStyle(.secondary)
                if model.pairingCode.isEmpty { ProgressView() }
                else {
                    if let qr = qrCode { Image(decorative: qr, scale: 1).interpolation(.none).resizable().frame(width: 155, height: 155).padding(15).background(.white, in: RoundedRectangle(cornerRadius: 16)) }
                    Text(model.pairingCode).font(.system(size: 30, weight: .medium, design: .monospaced)).textSelection(.enabled)
                    if let expires = model.pairingExpiresAt { TimelineView(.periodic(from: .now, by: 1)) { context in let remaining = max(0, Int(expires / 1000 - context.date.timeIntervalSince1970)); Text(remaining > 0 ? "\(remaining / 60):\(String(format: "%02d", remaining % 60)) 后失效" : "配对码已失效").font(.caption).foregroundStyle(.secondary) } }
                    Text("agentpaneld pair --relay \(model.relayURL) --code \(model.pairingCode)\nagentpaneld run").font(.system(.caption, design: .monospaced)).textSelection(.enabled).padding().background(.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
                    Button("生成新的配对码") { Task { await model.pair() } }
                }
            }.padding(30).frame(maxWidth: 460)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss(); Task { await model.reload() } } } }
        }.frame(minWidth: 340, minHeight: 540)
    }
    var qrCode: CGImage? {
        var parts = URLComponents()
        parts.scheme = "agentpanel"; parts.host = "pair"
        parts.queryItems = [URLQueryItem(name: "relay", value: model.relayURL), URLQueryItem(name: "code", value: model.pairingCode)]
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data((parts.string ?? model.pairingCode).utf8)
        guard let image = filter.outputImage else { return nil }
        return CIContext().createCGImage(image, from: image.extent)
    }
}

struct StatsView: View {
    @Bindable var model: AppModel
    var embedded = false
    @Environment(\.dismiss) private var dismiss
    @State private var device = ""
    @State private var agent = ""
    @State private var project = ""
    @State private var days = 30
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    HStack { VStack(alignment: .leading, spacing: 6) { Text("创造的轨迹").font(.largeTitle.bold()); Text("按设备、Agent 和项目了解你的用量。").foregroundStyle(.secondary) }; Spacer() }
                    HStack {
                        Picker("设备", selection: $device) { Text("全部设备").tag(""); ForEach(model.devices, id: \.id) { Text($0.name).tag($0.id) } }
                        Picker("Agent", selection: $agent) { Text("全部 Agent").tag(""); Text("Claude").tag("claude"); Text("Codex").tag("codex") }
                        Picker("时间", selection: $days) { Text("7 天").tag(7); Text("30 天").tag(30); Text("90 天").tag(90) }
                    }
                    TextField("项目路径筛选", text: $project).textFieldStyle(.roundedBorder).onSubmit { refresh() }
                    let usage = model.stats["usage"]
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 150))], spacing: 15) {
                        metric("输入 Token", value: number(usage["inputTokens"]))
                        metric("输出 Token", value: number(usage["outputTokens"]))
                        metric("缓存读取", value: number(usage["cacheReadTokens"]))
                        metric("缓存写入", value: number(usage["cacheWriteTokens"]))
                        metric("会话", value: number(model.stats["sessions"]))
                        metric("轮次", value: number(usage["turns"]))
                        metric("活跃时长", value: String(format: "%.1f 分钟", (usage["activeMs"].numberValue ?? 0) / 60000))
                        metric("费用估算", value: usage["costUsd"].numberValue.map { String(format: "$%.4f", $0) } ?? "价格未知")
                    }
                    if let buckets = model.stats["buckets"].arrayValue, !buckets.isEmpty {
                        Chart(Array(buckets.enumerated()), id: \.offset) { _, bucket in
                            BarMark(x: .value("日期", bucket["key"].stringValue ?? ""), y: .value("Token", (bucket["usage"]["inputTokens"].numberValue ?? 0) + (bucket["usage"]["outputTokens"].numberValue ?? 0))).foregroundStyle(.blue.gradient).cornerRadius(4)
                        }.frame(height: 220).padding(20).panelGlass()
                    } else { ContentUnavailableView("暂时没有用量", systemImage: "chart.bar", description: Text("运行会话或导入本地历史后，统计会显示在这里。")) }
                    NavigationLink("设置模型单价") { ModelPricingView(model: model, onSaved: refresh) }
                    Text("费用使用当前模型单价估算；来源已报告的费用优先保留。未知价格不会计为零费用，不代表订阅账单。").font(.caption).foregroundStyle(.secondary)
                    if let count = model.stats["unpricedSessions"].numberValue, count > 0 { Text("有 \(Int(count)) 个会话缺少价格，当前金额仅包含已知费用。").font(.caption).foregroundStyle(.orange) }
                }.padding(28)
            }.background { PanelBackdrop() }
            .refreshable { await model.loadStats(device: device, agent: agent, project: project, days: days) }
            .toolbar { if !embedded { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } } }
        }.frame(minWidth: 360, idealWidth: 760, minHeight: 570)
        .task { refresh() }.onChange(of: device) { refresh() }.onChange(of: agent) { refresh() }.onChange(of: days) { refresh() }
    }
    func refresh() { Task { await model.loadStats(device: device, agent: agent, project: project, days: days) } }
    func number(_ value: JSONValue) -> String { (value.numberValue ?? 0).formatted(.number.precision(.fractionLength(0))) }
    func metric(_ title: String, value: String) -> some View { VStack(alignment: .leading, spacing: 12) { Text(title).font(.caption).foregroundStyle(.secondary); Text(value).font(.title2.weight(.semibold)).monospacedDigit().lineLimit(1).minimumScaleFactor(0.7) }.frame(maxWidth: .infinity, alignment: .leading).padding(20).panelGlass() }
}

struct SettingsView: View {
    @Bindable var model: AppModel
    var embedded = false
    @Environment(\.dismiss) private var dismiss
    @State private var enabled = true
    @State private var approvals = true
    @State private var completed = true
    @State private var errors = true
    @State private var waiting = true
    @State private var preview = false
    @State private var scopeDevice = ""
    @State private var scopeSession = ""
    @State private var relayDraft = ""
    @State private var relayCheck: String?
    @State private var switching = false
    @State private var confirmLogout = false
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("邮箱", value: model.email.isEmpty ? "—" : model.email)
                    NavigationLink { PasswordSettingsView(model: model) } label: { LabeledContent("登录密码", value: model.passwordEnabled ? "已设置" : "未设置") }
                } header: { Text("账号") }
                Section {
                    TextField("https://relay.example.com", text: $relayDraft)
                        .textContentType(.URL)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        #endif
                    LabeledContent("状态") {
                        HStack(spacing: 6) { Circle().fill(model.isConnected ? .green : .orange).frame(width: 7, height: 7); Text(model.isConnected ? "已连接" : "正在重新连接") }
                    }
                    if let relayCheck { Text(relayCheck).font(.footnote).foregroundStyle(.secondary) }
                    Button("检查连接") { Task { await check() } }.disabled(normalized(relayDraft).isEmpty)
                    Button(switching ? "正在切换…" : "切换到此地址") { Task { switching = true; defer { switching = false }; if await model.switchRelay(to: relayDraft) { relayCheck = nil } } }
                        .disabled(switching || normalized(relayDraft).isEmpty || normalized(relayDraft) == model.relayURL)
                } header: { Text("后端服务（Relay）") } footer: {
                    Text("每个地址的登录分别保存；切换到未登录过的地址会回到登录页，切回原地址无需重新登录。局域网地址可使用 HTTP，其他地址必须使用 HTTPS。")
                }
                Section("会话列表") {
                    Picker("排序方式", selection: $model.sessionSort) { ForEach(SessionSort.allCases) { Text($0.label).tag($0) } }
                }
                Section {
                    ForEach(model.devices, id: \.id) { device in
                        NavigationLink { DeviceSettingsView(model: model, deviceId: device.id) } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                HStack(spacing: 6) { Circle().fill(device.online ? .green : .secondary.opacity(0.4)).frame(width: 7, height: 7); Text(device.name) }
                                let count = device.excludedProjects?.count ?? 0
                                Text(count == 0 ? "未排除项目文件夹" : "已排除 \(count) 个项目文件夹").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                    if model.devices.isEmpty { Text("还没有连接的设备").foregroundStyle(.secondary) }
                } header: { Text("设备") } footer: { Text("可为每台设备设置排除的项目文件夹，这些会话不会出现在会话列表和统计中。") }
                Section("通知偏好") {
                    Picker("设备范围", selection: $scopeDevice) { Text("全部设备").tag(""); ForEach(model.devices, id: \.id) { Text($0.name).tag($0.id) } }
                    Picker("会话范围", selection: $scopeSession) { Text("全部会话").tag(""); ForEach(model.sessions.filter { scopeDevice.isEmpty || $0.deviceId == scopeDevice }, id: \.id) { Text($0.title).tag($0.id) } }
                    Toggle("启用通知", isOn: $enabled); Toggle("权限审批", isOn: $approvals); Toggle("任务完成", isOn: $completed); Toggle("执行出错", isOn: $errors); Toggle("等待输入", isOn: $waiting); Toggle("在通知中显示会话内容", isOn: $preview)
                    Button("允许系统通知") { Task { await model.perform { try await NotificationBridge.shared.requestPermission() } } }
                    Button("保存通知偏好") { saveNotifications() }
                }
                Section("费用") { NavigationLink("模型单价 · USD / 百万 Token") { ModelPricingView(model: model) } }
                Section { Button("退出登录", role: .destructive) { confirmLogout = true } }
            }.formStyle(.grouped).navigationTitle("设置")
            .toolbar { if !embedded { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } } }
            .confirmationDialog("退出当前账号？", isPresented: $confirmLogout, titleVisibility: .visible) {
                Button("退出登录", role: .destructive) { Task { await model.logout(); dismiss() } }
            } message: { Text("此设备上该 Relay 的登录凭据会被删除。") }
        }.frame(minWidth: 360, idealWidth: 600, minHeight: 570)
        .task {
            relayDraft = model.relayURL
            if let status = try? await model.api.request("/api/auth/status", authenticated: false) { model.passwordEnabled = status["passwordEnabled"].boolValue ?? false }
            await loadNotifications()
        }
        .onChange(of: model.relayURL) { _, value in relayDraft = value }
        .onChange(of: scopeDevice) { scopeSession = ""; Task { await loadNotifications() } }
        .onChange(of: scopeSession) { Task { await loadNotifications() } }
    }
    private func normalized(_ value: String) -> String { value.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/")) }
    private func check() async {
        let probe = RelayClient()
        probe.origin = normalized(relayDraft)
        relayCheck = "正在检查…"
        do {
            let status = try await probe.request("/api/auth/status", authenticated: false)
            relayCheck = status["registered"].boolValue == false ? "可以连接，该 Relay 尚未创建账号。" : "可以连接。"
        } catch { relayCheck = "无法连接：\(error.localizedDescription)" }
    }
    func loadNotifications() async {
        do {
            let result = try await model.api.request("/api/push/settings")
            let settings = result["settings"].arrayValue ?? []
            let item = settings.first { ($0["deviceId"].stringValue ?? "") == scopeDevice && ($0["sessionId"].stringValue ?? "") == scopeSession } ?? .null
            enabled = item["enabled"].boolValue ?? true; approvals = item["approval"].boolValue ?? true; completed = item["completed"].boolValue ?? true; errors = item["error"].boolValue ?? true; waiting = item["waiting"].boolValue ?? true; preview = item["preview"].boolValue ?? false
        } catch where !isCancellation(error) { model.error = error.localizedDescription } catch {}
    }
    func saveNotifications() {
        Task { await model.perform {
            var values: [String: JSONValue] = ["enabled": .bool(enabled), "approval": .bool(approvals), "completed": .bool(completed), "error": .bool(errors), "waiting": .bool(waiting), "preview": .bool(preview)]
            if !scopeDevice.isEmpty { values["deviceId"] = .string(scopeDevice) }; if !scopeSession.isEmpty { values["sessionId"] = .string(scopeSession) }
            _ = try await model.api.request("/api/push/settings", method: "PUT", body: .object(values))
        } }
    }
}

struct PasswordSettingsView: View {
    @Bindable var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var currentPassword = ""
    @State private var newPassword = ""
    @State private var confirmPassword = ""
    var body: some View {
        Form {
            Section {
                if model.passwordEnabled { SecureField("当前密码", text: $currentPassword).textContentType(.password) }
                SecureField("新密码（至少 8 个字符）", text: $newPassword).textContentType(.newPassword)
                SecureField("确认新密码", text: $confirmPassword).textContentType(.newPassword)
                Button(model.passwordEnabled ? "更新密码" : "设置密码") { save() }.disabled(model.isBusy || newPassword.isEmpty)
            } footer: { Text(model.passwordEnabled ? "更新后，其他已登录的客户端需要重新登录。" : "设置后可在无法使用通行密钥的设备上用密码登录。") }
        }.formStyle(.grouped).navigationTitle(model.passwordEnabled ? "修改登录密码" : "设置登录密码")
    }
    func save() {
        guard newPassword.count >= 8 else { model.error = "密码至少需要 8 个字符"; return }
        guard newPassword == confirmPassword else { model.error = "两次输入的密码不一致"; return }
        Task { if await model.changePassword(current: currentPassword, new: newPassword) { dismiss() } }
    }
}

/// 单台设备的设置：名称、排除的项目文件夹、解绑。排除规则保存在 Relay，所有客户端和统计生效。
struct DeviceSettingsView: View {
    @Bindable var model: AppModel
    let deviceId: String
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var newPath = ""
    @State private var browsing = false
    @State private var confirmRevoke = false
    private var device: APDevice? { model.devices.first { $0.id == deviceId } }
    private var excluded: [String] { device?.excludedProjects ?? [] }
    /// 该设备最近会话涉及的项目，便于一键排除。
    private var recentProjects: [String] {
        var seen = Set(excluded)
        return model.sessions.filter { $0.deviceId == deviceId }.sorted { $0.updatedAt > $1.updatedAt }.map(\.cwd).filter { seen.insert($0).inserted }.prefix(12).map { $0 }
    }
    var body: some View {
        Form {
            if let device {
                Section("名称") {
                    HStack { TextField("设备名称", text: $name); Button("保存") { Task { _ = await model.updateDevice(deviceId, name: name.trimmingCharacters(in: .whitespaces)) } }.disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || name == device.name || model.isBusy) }
                    LabeledContent("系统", value: device.platform)
                    if let hostname = device.hostname { LabeledContent("主机名", value: hostname) }
                    LabeledContent("状态", value: device.online ? "在线" : "离线")
                }
                Section {
                    ForEach(excluded, id: \.self) { path in
                        Label { Text(path).font(.callout).lineLimit(2).truncationMode(.middle) } icon: { Image(systemName: "folder.badge.minus").foregroundStyle(.secondary) }
                    }
                    .onDelete { offsets in save(excluded.enumerated().filter { !offsets.contains($0.offset) }.map(\.element)) }
                    HStack {
                        TextField("绝对路径，例如 /Users/me/scratch", text: $newPath)
                            .autocorrectionDisabled()
                            #if os(iOS)
                            .textInputAutocapitalization(.never)
                            #endif
                            .onSubmit(addTyped)
                        Button("添加", action: addTyped).disabled(newPath.trimmingCharacters(in: .whitespaces).isEmpty || model.isBusy)
                    }
                    Button { browsing = true } label: { Label("在设备上浏览…", systemImage: "folder") }.disabled(!device.online || !model.isConnected)
                    if !recentProjects.isEmpty {
                        Menu { ForEach(recentProjects, id: \.self) { path in Button(path) { save(excluded + [path]) } } } label: { Label("从最近的项目中选择", systemImage: "clock") }
                    }
                } header: { Text("排除的项目文件夹") } footer: {
                    Text("这些文件夹及其子文件夹中的会话不会出现在会话列表和用量统计中。设备上的本地日志不受影响，删除规则后恢复显示。左滑可删除。")
                }
                Section { Button("解绑设备", role: .destructive) { confirmRevoke = true } } footer: { Text("解绑后设备立即断开，设备令牌失效，需要重新配对。") }
            } else { ContentUnavailableView("设备已移除", systemImage: "desktopcomputer.trianglebadge.exclamationmark") }
        }
        .formStyle(.grouped).navigationTitle(device?.name ?? "设备")
        .onAppear { name = device?.name ?? "" }
        .sheet(isPresented: $browsing) { FolderPickerView(model: model, deviceId: deviceId) { path in save(excluded + [path]) } }
        .confirmationDialog("解绑这台设备？它将立即断开连接，设备令牌也会失效。", isPresented: $confirmRevoke, titleVisibility: .visible) {
            Button("解绑设备", role: .destructive) { Task { await model.perform { _ = try await model.api.request("/api/devices/\(deviceId)", method: "DELETE"); await model.reload() }; dismiss() } }
        }
    }
    private func addTyped() {
        let path = newPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty else { return }
        save(excluded + [path]); newPath = ""
    }
    private func save(_ paths: [String]) { Task { _ = await model.updateDevice(deviceId, excludedProjects: paths) } }
}

/// 通过 fs.listDir 浏览设备目录并选择一个文件夹。
struct FolderPickerView: View {
    let model: AppModel
    let deviceId: String
    let onPick: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var listing: APDirectoryListing?
    @State private var loading = false
    @State private var failure: String?
    var body: some View {
        NavigationStack {
            List {
                if let listing {
                    Section { Text(listing.path.isEmpty ? "根目录" : listing.path).font(.footnote.monospaced()).foregroundStyle(.secondary).textSelection(.enabled) }
                    Section {
                        if let parent = listing.parent { Button { browse(parent) } label: { Label("上一级", systemImage: "arrow.up") } }
                        ForEach(listing.entries, id: \.path) { entry in Button { browse(entry.path) } label: { Label(entry.name, systemImage: "folder") } }
                    }
                } else if loading { ProgressView() }
                if let failure { Text(failure).foregroundStyle(.orange) }
            }
            .navigationTitle("选择要排除的文件夹")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("排除此文件夹") { if let path = listing?.path { onPick(path); dismiss() } }.disabled(listing?.path.isEmpty != false || loading) }
            }
        }.frame(minWidth: 340, idealWidth: 520, minHeight: 480)
        .task { browse(nil) }
    }
    private func browse(_ path: String?) {
        loading = true; failure = nil
        Task {
            defer { loading = false }
            do { listing = try await model.command("fs.listDir", device: deviceId, payload: ["path": .string(path ?? "")], awaitResult: true).decoded(APDirectoryListing.self) }
            catch { failure = error.localizedDescription }
        }
    }
}

struct ModelPricingView: View {
    @Bindable var model: AppModel
    var onSaved: () -> Void = {}
    @State private var catalog: [JSONValue] = []
    @State private var note = ""
    @State private var selected = ""
    @State private var customModel = ""
    @State private var rates = ["", "", "", ""]
    @State private var loading = true
    @State private var saving = false
    @State private var failure: String?
    @State private var message = ""
    private let fields = [("input", "非缓存输入"), ("output", "输出"), ("cacheRead", "缓存读取"), ("cacheWrite", "缓存写入")]
    var modelName: String { (selected == "__custom__" ? customModel : selected).trimmingCharacters(in: .whitespacesAndNewlines) }
    var entry: JSONValue { catalog.first { $0["model"].stringValue == modelName } ?? .null }
    var body: some View {
        Form {
            Section {
                if loading { ProgressView("正在加载单价") }
                else {
                    Picker("模型", selection: $selected) {
                        ForEach(catalog.indices, id: \.self) { index in
                            let item = catalog[index]
                            let name = item["model"].stringValue ?? ""
                            Text(name + (item["source"].stringValue == "unknown" ? " · 未设置" : "")).tag(name)
                        }
                        Text("添加其他模型…").tag("__custom__")
                    }
                    if selected == "__custom__" { TextField("准确模型名称", text: $customModel) }
                    if entry["source"].stringValue == "custom" { Text("自定义单价").foregroundStyle(.secondary) }
                    else if let source = entry["sourceUrl"].stringValue, let url = URL(string: source) { Link("官方参考价 · \(entry["checkedAt"].stringValue ?? "")", destination: url) }
                    else { Text("价格未知，可保持未设置。").foregroundStyle(.secondary) }
                }
            }
            if !loading {
                Section("USD / 百万 Token") {
                    ForEach(fields.indices, id: \.self) { index in
                        HStack {
                            Text(fields[index].1)
                            TextField("未设置", text: $rates[index]).multilineTextAlignment(.trailing)
                        }
                    }
                    Button(saving ? "正在保存…" : "保存模型单价") { Task { await save(reset: false) } }.disabled(saving || modelName.isEmpty)
                    Button("恢复默认") { Task { await save(reset: true) } }.disabled(saving || entry["source"].stringValue != "custom")
                    Text("保存后重新估算历史用量；免费项目请明确填 0。").font(.caption).foregroundStyle(.secondary)
                }.disabled(saving)
            }
            if let failure { Section { Text(failure).foregroundStyle(.red); Button("重新加载") { Task { await load() } } } }
            if !message.isEmpty { Section { Text(message).foregroundStyle(.secondary) } }
            if !note.isEmpty { Section { Text(note).font(.caption).foregroundStyle(.secondary) } }
        }
        .formStyle(.grouped).navigationTitle("模型费用")
        .task { await load() }
        .onChange(of: selected) { _, _ in fillRates(); message = "" }
        .onChange(of: customModel) { _, _ in fillRates(); message = "" }
    }
    func fillRates() { rates = fields.map { entry["price"][$0.0].numberValue.map { String($0) } ?? "" } }
    func load() async {
        loading = true; failure = nil
        defer { loading = false }
        do {
            let response = try await model.api.request("/api/pricing")
            catalog = response["models"].arrayValue ?? []; note = response["note"].stringValue ?? ""
            if selected.isEmpty { selected = catalog.first(where: { $0["observed"].boolValue == true })?["model"].stringValue ?? catalog.first?["model"].stringValue ?? "__custom__" }
            fillRates()
        } catch { failure = error.localizedDescription }
    }
    func save(reset: Bool) async {
        saving = true; failure = nil; message = ""
        defer { saving = false }
        do {
            if reset {
                var query = URLComponents(); query.queryItems = [URLQueryItem(name: "model", value: modelName)]
                _ = try await model.api.request("/api/pricing?\(query.percentEncodedQuery ?? "")", method: "DELETE")
            } else {
                guard !modelName.isEmpty, modelName.count <= 128 else { failure = "请输入有效模型名称。"; return }
                var values: [String: JSONValue] = ["model": .string(modelName)]
                for index in fields.indices {
                    guard let value = Double(rates[index].trimmingCharacters(in: .whitespacesAndNewlines)), value.isFinite, value >= 0, value <= 1_000_000 else { failure = "请填写四项有效单价（0 至 1,000,000）；未知价格可保持未设置。"; return }
                    values[fields[index].0] = .number(value)
                }
                _ = try await model.api.request("/api/pricing", method: "PUT", body: .object(values))
            }
            await load(); onSaved(); message = "已保存，历史估算已更新。"
        } catch { failure = error.localizedDescription }
    }
}
