import SwiftUI
import Charts

struct GlassSurface: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var opaque
    func body(content: Content) -> some View {
        if opaque { content.background(.background, in: RoundedRectangle(cornerRadius: 24)) }
        else if #available(iOS 26.0, macOS 26.0, *) { content.glassEffect(.regular, in: RoundedRectangle(cornerRadius: 24)) }
        else { content.background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 24)).overlay(RoundedRectangle(cornerRadius: 24).stroke(.white.opacity(0.22))) }
    }
}
extension View { func panelGlass() -> some View { modifier(GlassSurface()) } }

struct PanelBackdrop: View {
    @Environment(\.colorScheme) private var colorScheme
    var body: some View {
        ZStack {
            (colorScheme == .dark ? Color(red: 0.04, green: 0.065, blue: 0.11) : Color(red: 0.91, green: 0.94, blue: 0.97))
            GeometryReader { size in
                Ellipse().fill(Color.cyan.opacity(0.15)).frame(width: size.size.width * 0.75, height: size.size.height * 0.8).blur(radius: 65).offset(x: -120, y: -190)
                Ellipse().fill(Color.indigo.opacity(0.13)).frame(width: size.size.width * 0.8, height: size.size.height * 0.6).blur(radius: 75).offset(x: size.size.width * 0.55, y: size.size.height * 0.65)
            }
        }.ignoresSafeArea()
    }
}

struct RootView: View {
    @Bindable var model: AppModel
    @State private var showDevices = false
    @State private var showStats = false
    @State private var showSettings = false
    @State private var showNew = false
    @State private var showPair = false
    @State private var search = ""
    var body: some View {
        ZStack {
            PanelBackdrop()
            if model.isAuthenticated {
                NavigationSplitView {
                    List(selection: $model.selectedDevice) {
                        Section {
                            Label("全部设备", systemImage: "rectangle.3.group").tag(String?.none)
                            ForEach(model.devices, id: \.id) { device in
                                HStack(spacing: 10) {
                                    Image(systemName: device.platform == "darwin" ? "desktopcomputer" : "server.rack").foregroundStyle(.secondary)
                                    VStack(alignment: .leading, spacing: 4) { Text(device.name); Text(device.online ? "在线" : "离线").font(.caption).foregroundStyle(device.online ? .green : .secondary) }
                                }.tag(Optional(device.id))
                            }
                        } header: { Text("工作空间") }
                        Section {
                            Button { showPair = true; Task { await model.pair() } } label: { Label("连接设备", systemImage: "plus.circle") }
                            Button { showDevices = true } label: { Label("设备与订阅额度", systemImage: "gauge.with.dots.needle.50percent") }
                            Button { showStats = true } label: { Label("用量统计", systemImage: "chart.xyaxis.line") }
                            Button { showSettings = true } label: { Label("设置", systemImage: "slider.horizontal.3") }
                        }
                    }
                    .scrollContentBackground(.hidden)
                    .navigationTitle("AgentPanel")
                    .safeAreaInset(edge: .bottom) { HStack { Circle().fill(model.isConnected ? .green : .orange).frame(width: 6, height: 6); Text(model.isConnected ? "与 Relay 已连接" : "正在重新连接…").font(.caption); Spacer() }.padding() }
                    .navigationSplitViewColumnWidth(min: 190, ideal: 220, max: 280)
                } content: {
                    List(selection: $model.selectedSession) {
                        let filtered = model.visibleSessions.filter { search.isEmpty || "\($0.title) \($0.cwd)".localizedCaseInsensitiveContains(search) }
                        ForEach(Array(Set(filtered.map(\.cwd))).sorted(), id: \.self) { cwd in
                            Section((cwd as NSString).lastPathComponent.isEmpty ? cwd : (cwd as NSString).lastPathComponent) {
                                ForEach(filtered.filter { $0.cwd == cwd }, id: \.id) { session in
                                    NavigationLink(value: session.id) { SessionRow(session: session) }
                                }
                            }
                        }
                    }
                    .overlay { if model.visibleSessions.isEmpty { ContentUnavailableView("从一个想法开始", systemImage: "sparkle", description: Text("连接设备，创建你的第一个会话。")) } }
                    .scrollContentBackground(.hidden)
                    .searchable(text: $search, prompt: "搜索会话或项目")
                    .navigationTitle("会话")
                    .toolbar { Button { showNew = true } label: { Image(systemName: "square.and.pencil") }.help("新建会话"); Button { Task { await model.reload() } } label: { Image(systemName: "arrow.clockwise") }.help("刷新") }
                    .navigationSplitViewColumnWidth(min: 230, ideal: 290, max: 380)
                } detail: {
                    SessionDetail(model: model)
                }
                .onChange(of: model.selectedSession) { _, id in if let id { Task { await model.loadHistory(id) } } }
            } else { WelcomeView(model: model) }
        }
        .tint(Color(red: 0.16, green: 0.45, blue: 0.75))
        .sheet(isPresented: $showNew) { NewSessionView(model: model) }
        .sheet(isPresented: $showDevices) { DeviceQuotaView(model: model) }
        .sheet(isPresented: $showStats) { StatsView(model: model) }
        .sheet(isPresented: $showSettings) { SettingsView(model: model) }
        .sheet(isPresented: $showPair) { PairingView(model: model) }
        .alert("操作未完成", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) { Button("知道了", role: .cancel) { model.error = nil } } message: { Text(model.error ?? "") }
        .sheet(isPresented: Binding(get: { !model.recoveryCodes.isEmpty }, set: { if !$0 { model.recoveryCodes = [] } })) {
            VStack(alignment: .leading, spacing: 20) { Text("保存恢复码").font(.title2.bold()); Text("每个恢复码只能使用一次。请将它们保存在安全的地方，以便通行密钥丢失时找回账号。"); Text(model.recoveryCodes.joined(separator: "\n")).font(.system(.body, design: .monospaced)).textSelection(.enabled); Button("已妥善保存") { model.recoveryCodes = [] }.buttonStyle(.borderedProminent) }.padding(32).frame(minWidth: 320)
        }
    }
}

struct WelcomeView: View {
    @Bindable var model: AppModel
    @State private var recovery = false
    var body: some View {
        ScrollView {
            VStack(spacing: 30) {
                VStack(spacing: 16) {
                    Image(systemName: "square.stack.3d.up.fill").font(.system(size: 48, weight: .light)).foregroundStyle(.blue.gradient).padding(28).panelGlass()
                    Text("AgentPanel").font(.system(size: 38, weight: .semibold, design: .rounded))
                    Text("让每一台设备，都在你的掌控之中。").foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 20) {
                    Text(recovery ? "恢复账号" : model.isRegistered ? "回到你的工作空间" : "建立你的工作空间").font(.title2.weight(.semibold))
                    TextField("Relay 地址", text: $model.relayURL).textContentType(.URL)
                    TextField("账号邮箱", text: $model.email).textContentType(.emailAddress)
                    if recovery { SecureField("一次性恢复码", text: $model.recoveryCode) }
                    else if !model.isRegistered { SecureField("初始注册凭证", text: $model.bootstrapToken) }
                    Button { Task { if recovery { await model.recover() } else { await model.login(register: !model.isRegistered) } } } label: {
                        HStack { if model.isBusy { ProgressView().controlSize(.small) } else { Image(systemName: "person.badge.key") }; Text(recovery ? "恢复并设置通行密钥" : model.isRegistered ? "使用通行密钥登录" : "创建通行密钥"); Spacer(); Image(systemName: "arrow.right") }.padding(.vertical, 8)
                    }.buttonStyle(.borderedProminent).disabled(model.isBusy || model.email.isEmpty)
                    HStack { Button("检查连接") { Task { await model.inspectServer() } }; Spacer(); Button(recovery ? "返回登录" : "使用恢复码") { recovery.toggle() } }.font(.callout)
                }.textFieldStyle(.roundedBorder).padding(30).panelGlass().frame(maxWidth: 460)
                Text("你的设备 · 你的会话 · 你的工作空间").font(.caption).foregroundStyle(.secondary)
            }.padding(30).frame(maxWidth: .infinity).padding(.top, 65)
        }.task { await model.inspectServer() }
    }
}

struct SessionRow: View {
    let session: APSession
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack { Text(session.title).font(.callout.weight(.medium)).lineLimit(2); Spacer(); if session.readOnly { Image(systemName: "lock").font(.caption) } }
            HStack { Text(session.agent == "claude" ? "Claude" : "Codex"); Circle().frame(width: 3, height: 3); Text(statusLabel(session.status)); Spacer(); Text(Date(timeIntervalSince1970: Double(session.updatedAt) / 1000), style: .relative) }.font(.caption2).foregroundStyle(.secondary)
        }.padding(.vertical, 6)
    }
}
func statusLabel(_ status: String) -> String { ["idle": "就绪", "running": "进行中", "waiting": "等待审批", "completed": "已完成", "error": "出错", "readonly": "只读"][status] ?? status }

struct SessionDetail: View {
    @Bindable var model: AppModel
    @State private var prompt = ""
    @State private var showLocalHistory = false
    var body: some View {
        if let session = model.currentSession {
            VStack(spacing: 0) {
                if session.readOnly { Label(session.busyReason ?? "该会话正在本地使用，暂以只读模式查看", systemImage: "lock.shield").font(.callout).padding().frame(maxWidth: .infinity).background(.orange.opacity(0.08)) }
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 18) {
                            ForEach(coalesced(model.events[session.id] ?? []), id: \.id) { message in EventView(envelope: message).id(message.id) }
                            ForEach(model.pendingApprovals.filter { $0.sessionId == session.id }, id: \.id) { approval in ApprovalCard(approval: approval, model: model) }
                            Color.clear.frame(height: 1).id("end")
                        }.padding(24).frame(maxWidth: 900).frame(maxWidth: .infinity)
                    }.onChange(of: model.events[session.id]?.count) { _, _ in proxy.scrollTo("end", anchor: .bottom) }
                }
                HStack(alignment: .bottom, spacing: 12) {
                    TextField("继续这个想法…", text: $prompt, axis: .vertical).lineLimit(1...7).textFieldStyle(.plain).padding(10).onSubmit { submit(session) }
                    if session.status == "running" || session.status == "waiting" {
                        Button { Task { await model.perform { _ = try await model.command("session.interrupt", device: session.deviceId, session: session.id) } } } label: { Image(systemName: "stop.fill").padding(8) }.help("中断当前轮次").disabled(session.readOnly || !model.isConnected)
                    } else {
                        Button { submit(session) } label: { Image(systemName: "arrow.up").fontWeight(.semibold).padding(8) }.buttonStyle(.borderedProminent).disabled(prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || session.readOnly || !model.isConnected)
                    }
                }.padding(10).panelGlass().padding(18)
            }
            .navigationTitle(session.title)
            .toolbar {
                if session.nativeId != nil { Button { showLocalHistory = true } label: { Image(systemName: "clock.arrow.circlepath") }.help("读取设备本地历史") }
                Text(session.agent.capitalized).font(.caption).foregroundStyle(.secondary)
            }
            .sheet(isPresented: $showLocalHistory) { LocalHistoryView(model: model, session: session) }
        } else {
            ContentUnavailableView { Label("在这里，继续创造", systemImage: "sparkles") } description: { Text("选择一个会话，或者开启新的想法。\nClaude 与 Codex，跨设备始终连贯。") }
        }
    }
    private func submit(_ session: APSession) {
        guard !session.readOnly, model.isConnected, !["running", "waiting"].contains(session.status), !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let text = prompt; prompt = ""
        Task { await model.perform { _ = try await model.command(session.source == "local" && session.status != "running" ? "session.resume" : "session.send", device: session.deviceId, session: session.id, payload: ["prompt": .string(text)]) } }
    }
}

struct LocalHistoryView: View {
    let model: AppModel
    let session: APSession
    @Environment(\.dismiss) private var dismiss
    @State private var events: [APEnvelope] = []
    @State private var loading = true
    @State private var failure: String?
    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    if loading { ProgressView("正在读取设备记录…") }
                    if let failure { Text(failure).foregroundStyle(.orange) }
                    ForEach(coalesced(events), id: \.id) { EventView(envelope: $0) }
                    if !loading && events.isEmpty && failure == nil { ContentUnavailableView("暂无本地记录", systemImage: "clock") }
                }.padding(24)
            }.navigationTitle("设备本地记录")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }.frame(minWidth: 340, idealWidth: 700, minHeight: 500)
        .task { do { events = try await model.readLocalHistory(session) } catch { failure = error.localizedDescription }; loading = false }
    }
}

struct EventView: View {
    let envelope: APEnvelope
    var body: some View {
        let value = envelope.payload
        let kind = value["kind"].stringValue ?? ""
        if kind.hasPrefix("tool.") {
            DisclosureGroup {
                if let diff = value["diff"].stringValue {
                    VStack(alignment: .leading, spacing: 2) { ForEach(Array(diff.components(separatedBy: "\n").enumerated()), id: \.offset) { line in Text(line.element).foregroundStyle(line.element.hasPrefix("+") ? .green : line.element.hasPrefix("-") ? .red : .primary).frame(maxWidth: .infinity, alignment: .leading) } }.font(.system(.caption, design: .monospaced))
                }
                Text((value["output"] != .null ? value["output"] : value["input"]).pretty).font(.system(.caption, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
            } label: { Label(value["toolName"].stringValue ?? "工具结果", systemImage: kind == "tool.call" ? "terminal" : "checkmark.circle").font(.callout) }.padding(15).background(.secondary.opacity(0.05), in: RoundedRectangle(cornerRadius: 16))
        } else if kind == "thinking.delta" {
            DisclosureGroup("思考摘要") { Text(value["text"].stringValue ?? "").font(.callout).foregroundStyle(.secondary).textSelection(.enabled) }.font(.caption).foregroundStyle(.secondary)
        } else if kind == "error" {
            Label(value["error"]["message"].stringValue ?? "发生错误", systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
        } else {
            let isUser = value["role"].stringValue == "user"
            VStack(alignment: .leading, spacing: 10) {
                Text(isUser ? "你" : "\(value["model"].stringValue ?? "助手")").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                MarkdownBody(text: value["text"].stringValue ?? "")
            }.padding(isUser ? 18 : 0).background(isUser ? Color.blue.opacity(0.07) : .clear, in: RoundedRectangle(cornerRadius: 20))
        }
    }
}

struct MarkdownBody: View {
    let text: String
    private struct Block { let language: String?; let text: String }
    private var blocks: [Block] {
        var result: [Block] = []
        var lines: [String] = []
        var language: String?
        for line in text.components(separatedBy: "\n") {
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                if !lines.isEmpty { result.append(Block(language: language, text: lines.joined(separator: "\n"))); lines = [] }
                if language == nil { language = String(line.trimmingCharacters(in: .whitespaces).dropFirst(3)) }
                else { language = nil }
            } else { lines.append(line) }
        }
        if !lines.isEmpty { result.append(Block(language: language, text: lines.joined(separator: "\n"))) }
        return result
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                if let language = block.language {
                    VStack(alignment: .leading, spacing: 10) {
                        if !language.isEmpty { Text(language).font(.caption).foregroundStyle(.secondary) }
                        ScrollView(.horizontal) { Text(block.text).font(.system(.callout, design: .monospaced)).textSelection(.enabled) }
                    }.padding(15).background(.secondary.opacity(0.07), in: RoundedRectangle(cornerRadius: 14))
                } else {
                    Text((try? AttributedString(markdown: block.text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(block.text)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }
}

struct ApprovalCard: View {
    let approval: APApproval
    @Bindable var model: AppModel
    var body: some View {
        VStack(alignment: .leading, spacing: 15) {
            Label("需要你的许可", systemImage: "hand.raised").font(.headline)
            Text(approval.toolName).font(.system(.body, design: .monospaced))
            Text(approval.input.pretty).font(.system(.caption, design: .monospaced)).lineLimit(12).textSelection(.enabled)
            HStack { Text("有效期至 \(Date(timeIntervalSince1970: Double(approval.expiresAt) / 1000).formatted(date: .omitted, time: .shortened))").font(.caption).foregroundStyle(.secondary); Spacer(); Button("拒绝", role: .destructive) { Task { await model.decide(approval, allow: false) } }; Button("允许这一次") { Task { await model.decide(approval, allow: true) } }.buttonStyle(.borderedProminent) }.disabled(model.isBusy)
        }.padding(22).panelGlass()
    }
}


struct DeviceQuotaView: View {
    @Bindable var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var refreshing = Set<String>()
    var body: some View {
        NavigationStack {
            List {
                ForEach(model.devices, id: \.id) { device in
                    Section {
                        HStack {
                            Label(device.online ? "在线" : "离线", systemImage: "circle.fill").foregroundStyle(device.online ? .green : .secondary)
                            Spacer()
                            Button("刷新额度") {
                                refreshing.insert(device.id)
                                Task {
                                    defer { refreshing.remove(device.id) }
                                    await model.perform { _ = try await model.command("device.refresh", device: device.id, awaitResult: true) }
                                }
                            }.disabled(!device.online || !model.isConnected || refreshing.contains(device.id))
                        }
                        ForEach(device.agents, id: \.kind) { agent in
                            AgentQuotaView(agent: agent, online: device.online)
                        }
                    } header: { Text(device.name) }
                }
            }
            .navigationTitle("设备与订阅额度")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }.frame(minWidth: 340, idealWidth: 560, minHeight: 480)
    }
}

struct AgentQuotaView: View {
    let agent: APAgentCapability
    let online: Bool
    var body: some View {
        TimelineView(.periodic(from: .now, by: 15)) { context in
            let now = context.date.timeIntervalSince1970 * 1000
            let execution = agent.executionAvailable ?? agent.authenticated
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(agent.kind == "claude" ? "Claude Code" : "Codex").font(.headline)
                    Spacer()
                    Text(!agent.installed ? "未安装" : execution == true ? "可运行任务" : execution == false ? "运行受限" : "运行状态未知").font(.caption).foregroundStyle(.secondary)
                }
                if let version = agent.version { Text(version).font(.caption2).foregroundStyle(.secondary) }
                if let message = agent.authMessage { Text(message).font(.caption).foregroundStyle(.secondary) }
                if let quota = agent.quota {
                    let stale = !online || quota.status == "stale" || quota.staleAt.map { now >= Double($0) } == true
                    ForEach(quota.windows, id: \.id) { window in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack { Text(window.label); Spacer(); Text("\(stale ? "上次剩余" : "剩余") \(String(format: "%.1f", 100 - window.usedPercent))%") }.font(.caption)
                            ProgressView(value: 100 - window.usedPercent, total: 100).opacity(stale ? 0.45 : 1)
                                .accessibilityLabel("\(window.label)\(stale ? "上次" : "")剩余百分比")
                            if let reset = window.resetsAt { Text("\(quotaDate(reset)) 重置\(now >= Double(reset) ? "（待刷新）" : "")").font(.caption2).foregroundStyle(.secondary) }
                        }
                    }
                    if let message = quota.message, quota.windows.isEmpty { Text(message).font(.caption).foregroundStyle(.secondary) }
                    if stale && !quota.windows.isEmpty { Text(online ? "额度数据已过期，等待刷新" : "设备离线，显示上次查询结果").font(.caption).foregroundStyle(.secondary) }
                    if let source = quota.source { Text(source).font(.caption2).foregroundStyle(.secondary) }
                    if let updated = quota.updatedAt { Text("\(quotaDate(updated)) 更新").font(.caption2).foregroundStyle(.secondary) }
                    if let retry = quota.retryAt, Double(retry) > now { Text("\(quotaDate(retry)) 后可重试").font(.caption2).foregroundStyle(.secondary) }
                } else { Text("额度信息尚未上报，请确认 Daemon 与 Relay 均已更新并重启").font(.caption).foregroundStyle(.secondary) }
            }.padding(.vertical, 6)
        }
    }
    private func quotaDate(_ milliseconds: Int) -> String {
        Date(timeIntervalSince1970: Double(milliseconds) / 1000).formatted(date: .abbreviated, time: .shortened)
    }
}
