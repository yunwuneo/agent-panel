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
                ToolbarItem(placement: .confirmationAction) { Button("开始") { create() }.disabled(device.isEmpty || cwd.isEmpty || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || loading || capability?.installed == false || capability?.authenticated == false) }
            }
        }.frame(minWidth: 340, idealWidth: 560, minHeight: 520)
        .onAppear { device = model.devices.first { $0.id == model.selectedDevice && $0.online }?.id ?? model.devices.first(where: \.online)?.id ?? "" }
        .onChange(of: device) { _, _ in
            entries = nil; cwd = ""; agentModel = ""
            let available = model.devices.first { $0.id == device }?.agents.first { $0.installed && $0.authenticated == true }
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
                Text("在需要控制的设备上输入配对码。\n一次配对，随时继续工作。").multilineTextAlignment(.center).foregroundStyle(.secondary)
                if model.pairingCode.isEmpty { ProgressView() }
                else {
                    if let qr = qrCode { Image(decorative: qr, scale: 1).interpolation(.none).resizable().frame(width: 155, height: 155).padding(15).background(.white, in: RoundedRectangle(cornerRadius: 16)) }
                    Text(model.pairingCode).font(.system(size: 30, weight: .medium, design: .monospaced)).textSelection(.enabled)
                    if let expires = model.pairingExpiresAt { TimelineView(.periodic(from: .now, by: 1)) { context in let remaining = max(0, Int(expires / 1000 - context.date.timeIntervalSince1970)); Text(remaining > 0 ? "\(remaining / 60):\(String(format: "%02d", remaining % 60)) 后失效" : "配对码已失效").font(.caption).foregroundStyle(.secondary) } }
                    Text("agentpaneld pair --relay \(model.relayURL) --code \(model.pairingCode)").font(.system(.caption, design: .monospaced)).textSelection(.enabled).padding().background(.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
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
                    Text("费用由模型价格表估算，实际账单以服务商为准。未知价格不会计为零费用。").font(.caption).foregroundStyle(.secondary)
                    if let count = model.stats["unpricedSessions"].numberValue, count > 0 { Text("有 \(Int(count)) 个会话缺少价格，当前金额仅包含已知费用。").font(.caption).foregroundStyle(.orange) }
                }.padding(28)
            }.background { PanelBackdrop() }
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }.frame(minWidth: 360, idealWidth: 760, minHeight: 570)
        .task { refresh() }.onChange(of: device) { refresh() }.onChange(of: agent) { refresh() }.onChange(of: days) { refresh() }
    }
    func refresh() { Task { await model.loadStats(device: device, agent: agent, project: project, days: days) } }
    func number(_ value: JSONValue) -> String { (value.numberValue ?? 0).formatted(.number.precision(.fractionLength(0))) }
    func metric(_ title: String, value: String) -> some View { VStack(alignment: .leading, spacing: 12) { Text(title).font(.caption).foregroundStyle(.secondary); Text(value).font(.title2.weight(.semibold)).monospacedDigit().lineLimit(1).minimumScaleFactor(0.7) }.frame(maxWidth: .infinity, alignment: .leading).padding(20).panelGlass() }
}

struct SettingsView: View {
    @Bindable var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var enabled = true
    @State private var approvals = true
    @State private var completed = true
    @State private var errors = true
    @State private var waiting = true
    @State private var preview = false
    @State private var scopeDevice = ""
    @State private var scopeSession = ""
    @State private var renameId = ""
    @State private var rename = ""
    @State private var revoke: APDevice?
    var body: some View {
        NavigationStack {
            Form {
                Section("连接") { LabeledContent("Relay", value: model.relayURL); LabeledContent("账号", value: model.email) }
                Section("通知偏好") {
                    Picker("设备范围", selection: $scopeDevice) { Text("全部设备").tag(""); ForEach(model.devices, id: \.id) { Text($0.name).tag($0.id) } }
                    Picker("会话范围", selection: $scopeSession) { Text("全部会话").tag(""); ForEach(model.sessions.filter { scopeDevice.isEmpty || $0.deviceId == scopeDevice }, id: \.id) { Text($0.title).tag($0.id) } }
                    Toggle("启用通知", isOn: $enabled); Toggle("权限审批", isOn: $approvals); Toggle("任务完成", isOn: $completed); Toggle("执行出错", isOn: $errors); Toggle("等待输入", isOn: $waiting); Toggle("在通知中显示会话内容", isOn: $preview)
                    Button("允许系统通知") { Task { await model.perform { try await NotificationBridge.shared.requestPermission() } } }
                    Button("保存通知偏好") { saveNotifications() }
                }
                Section("设备") {
                    ForEach(model.devices, id: \.id) { device in
                        HStack { Text(device.name); Spacer(); Button("重命名") { renameId = device.id; rename = device.name }; Button("解绑", role: .destructive) { revoke = device } }
                    }
                    if !renameId.isEmpty { HStack { TextField("设备名称", text: $rename); Button("保存") { Task { await model.perform { _ = try await model.api.request("/api/devices/\(renameId)", method: "PATCH", body: .object(["name": .string(rename)])); renameId = ""; await model.reload() } } } } }
                }
                Section { Button("退出登录", role: .destructive) { Task { await model.logout(); dismiss() } } }
            }.formStyle(.grouped).navigationTitle("设置")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }.frame(minWidth: 360, idealWidth: 600, minHeight: 570)
        .task { await loadNotifications() }
        .onChange(of: scopeDevice) { scopeSession = ""; Task { await loadNotifications() } }
        .onChange(of: scopeSession) { Task { await loadNotifications() } }
        .confirmationDialog("解绑这台设备？它将立即断开连接，设备令牌也会失效。", isPresented: Binding(get: { revoke != nil }, set: { if !$0 { revoke = nil } })) {
            Button("解绑设备", role: .destructive) { guard let device = revoke else { return }; Task { await model.perform { _ = try await model.api.request("/api/devices/\(device.id)", method: "DELETE"); await model.reload() }; revoke = nil } }
        }
    }
    func loadNotifications() async {
        do {
            let result = try await model.api.request("/api/push/settings")
            let settings = result["settings"].arrayValue ?? []
            let item = settings.first { ($0["deviceId"].stringValue ?? "") == scopeDevice && ($0["sessionId"].stringValue ?? "") == scopeSession } ?? .null
            enabled = item["enabled"].boolValue ?? true; approvals = item["approval"].boolValue ?? true; completed = item["completed"].boolValue ?? true; errors = item["error"].boolValue ?? true; waiting = item["waiting"].boolValue ?? true; preview = item["preview"].boolValue ?? false
        } catch { model.error = error.localizedDescription }
    }
    func saveNotifications() {
        Task { await model.perform {
            var values: [String: JSONValue] = ["enabled": .bool(enabled), "approval": .bool(approvals), "completed": .bool(completed), "error": .bool(errors), "waiting": .bool(waiting), "preview": .bool(preview)]
            if !scopeDevice.isEmpty { values["deviceId"] = .string(scopeDevice) }; if !scopeSession.isEmpty { values["sessionId"] = .string(scopeSession) }
            _ = try await model.api.request("/api/push/settings", method: "PUT", body: .object(values))
        } }
    }
}
