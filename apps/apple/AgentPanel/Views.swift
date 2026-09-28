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
                #if os(iOS)
                PhoneRootView(model: model, showNew: $showNew)
                #else
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
                    SessionList(model: model, search: search)
                    .searchable(text: $search, prompt: "搜索会话或项目")
                    .navigationTitle("会话")
                    .toolbar { SessionSortMenu(model: model, showsDevices: false); Button { showNew = true } label: { Image(systemName: "square.and.pencil") }.help("新建会话"); Button { Task { await model.reload() } } label: { Image(systemName: "arrow.clockwise") }.help("刷新") }
                    .navigationSplitViewColumnWidth(min: 230, ideal: 290, max: 380)
                } detail: {
                    SessionDetail(model: model)
                }
                #endif
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
            VStack(alignment: .leading, spacing: 20) { Text("保存恢复码").font(.title2.bold()); Text("每个恢复码只能使用一次。请将它们保存在安全的地方，以便无法登录时找回账号。"); Text(model.recoveryCodes.joined(separator: "\n")).font(.system(.body, design: .monospaced)).textSelection(.enabled); Button("已妥善保存") { model.recoveryCodes = [] }.buttonStyle(.borderedProminent) }.padding(32).frame(minWidth: 320)
        }
    }
}

#if os(iOS)
/// iPhone / iPad 的主界面：系统 TabView，iOS 26 起自动呈现 Liquid Glass 底栏，旧系统为标准标签栏。
struct PhoneRootView: View {
    enum PanelTab: Hashable { case sessions, devices, stats, settings, search }
    @Bindable var model: AppModel
    @Binding var showNew: Bool
    @State private var tab = PanelTab.sessions
    @State private var search = ""
    var body: some View {
        TabView(selection: $tab) {
            Tab("会话", systemImage: "bubble.left.and.text.bubble.right", value: PanelTab.sessions) {
                NavigationSplitView {
                    SessionList(model: model)
                        .navigationTitle("会话")
                        .refreshable { await model.reload() }
                        .toolbar {
                            ToolbarItem(placement: .topBarLeading) { SessionSortMenu(model: model, showsDevices: true) }
                            ToolbarItem(placement: .topBarTrailing) { Button { showNew = true } label: { Image(systemName: "square.and.pencil") }.accessibilityLabel("新建会话") }
                        }
                } detail: { SessionDetail(model: model) }
            }.badge(model.pendingApprovals.count)
            Tab("设备", systemImage: "desktopcomputer", value: PanelTab.devices) { DeviceQuotaView(model: model, embedded: true) }
            Tab("统计", systemImage: "chart.xyaxis.line", value: PanelTab.stats) { StatsView(model: model, embedded: true) }
            Tab("设置", systemImage: "gearshape", value: PanelTab.settings) { SettingsView(model: model, embedded: true) }
            Tab("搜索", systemImage: "magnifyingglass", value: PanelTab.search, role: .search) {
                NavigationSplitView {
                    SessionList(model: model, search: search)
                        .navigationTitle("搜索")
                        .searchable(text: $search, prompt: "搜索会话或项目")
                } detail: { SessionDetail(model: model) }
            }
        }
        .tabViewStyle(.sidebarAdaptable)
        .modifier(MinimizingTabBar())
        .onChange(of: model.selectedSession) { _, id in if id != nil && tab != .search { tab = .sessions } }
    }
}

/// iOS 26 起滚动时收起 Liquid Glass 底栏；旧系统保持原样。
struct MinimizingTabBar: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) { content.tabBarMinimizeBehavior(.onScrollDown) } else { content }
    }
}
#endif

struct SessionSortMenu: View {
    @Bindable var model: AppModel
    let showsDevices: Bool
    var body: some View {
        Menu {
            Picker("排序", selection: $model.sessionSort) { ForEach(SessionSort.allCases) { Label($0.label, systemImage: $0.symbol).tag($0) } }
            if showsDevices && model.devices.count > 1 {
                Picker("设备", selection: $model.selectedDevice) {
                    Label("全部设备", systemImage: "rectangle.3.group").tag(String?.none)
                    ForEach(model.devices, id: \.id) { Label($0.name, systemImage: $0.online ? "circle.fill" : "circle").tag(Optional($0.id)) }
                }
            }
        } label: { Image(systemName: "line.3.horizontal.decrease") }
        .accessibilityLabel("排序与筛选")
    }
}

/// 参考 ChatGPT iOS 的会话列表：单行标题、细分组标题、无卡片背景，一屏容纳更多会话。
struct SessionList: View {
    @Bindable var model: AppModel
    var search = ""
    @State private var collapsed: Set<String> = []
    var body: some View {
        let sessions = model.visibleSessions.filter { search.isEmpty || "\($0.title) \($0.cwd)".localizedCaseInsensitiveContains(search) }
        let groups = sessionGroups(sessions, sort: model.sessionSort, deviceNames: model.devices.count > 1 && model.selectedDevice == nil ? Dictionary(model.devices.map { ($0.id, $0.name) }, uniquingKeysWith: { a, _ in a }) : [:])
        List(selection: $model.selectedSession) {
            if !model.isConnected {
                Label("正在重新连接 Relay…", systemImage: "wifi.exclamationmark").font(.footnote).foregroundStyle(.orange).listRowSeparator(.hidden)
            }
            ForEach(groups) { group in
                Section {
                    if !collapsed.contains(group.id) {
                        ForEach(group.sessions, id: \.id) { session in
                            CompactSessionRow(session: session, showProject: model.sessionSort != .project).tag(session.id)
                                .listRowSeparator(.hidden)
                                .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 12))
                                .contextMenu {
                                    Button { Task { await exclude(session) } } label: { Label("不再显示此项目", systemImage: "eye.slash") }
                                }
                        }
                    }
                } header: {
                    if model.sessionSort == .project {
                        Button { withAnimation(.snappy) { if collapsed.contains(group.id) { collapsed.remove(group.id) } else { collapsed.insert(group.id) } } } label: {
                            HStack(spacing: 6) {
                                Image(systemName: "folder").imageScale(.small)
                                Text(group.title).lineLimit(1)
                                if let detail = group.detail { Text(detail).foregroundStyle(.tertiary).lineLimit(1) }
                                Spacer()
                                Text("\(group.sessions.count)").monospacedDigit().foregroundStyle(.tertiary)
                                Image(systemName: "chevron.right").imageScale(.small).rotationEffect(.degrees(collapsed.contains(group.id) ? 0 : 90))
                            }.font(.footnote.weight(.semibold)).foregroundStyle(.secondary).contentShape(Rectangle())
                        }.buttonStyle(.plain)
                    } else { Text(group.title).font(.footnote.weight(.semibold)).foregroundStyle(.secondary) }
                }
            }
        }
        #if os(iOS)
        .listStyle(.plain)
        #endif
        .environment(\.defaultMinListRowHeight, 38)
        .environment(\.defaultMinListHeaderHeight, 26)
        .scrollContentBackground(.hidden)
        .overlay {
            if model.visibleSessions.isEmpty { ContentUnavailableView("从一个想法开始", systemImage: "sparkle", description: Text("连接设备，创建你的第一个会话。")) }
            else if sessions.isEmpty { ContentUnavailableView.search(text: search) }
        }
    }
    private func exclude(_ session: APSession) async {
        guard let device = model.devices.first(where: { $0.id == session.deviceId }) else { return }
        _ = await model.updateDevice(device.id, excludedProjects: (device.excludedProjects ?? []) + [session.cwd])
    }
}

struct SessionGroup: Identifiable {
    let id: String
    let title: String
    var detail: String?
    var sessions: [APSession]
}

/// 按排序方式分组；组内始终按更新时间倒序。
func sessionGroups(_ sessions: [APSession], sort: SessionSort, deviceNames: [String: String] = [:], now: Date = .now) -> [SessionGroup] {
    let ordered = sessions.sorted { $0.updatedAt > $1.updatedAt }
    switch sort {
    case .priority:
        let tiers = [("waiting", "等待审批"), ("running", "进行中"), ("error", "出错"), ("rest", "最近")]
        func tier(_ session: APSession) -> String { ["waiting", "running", "error"].contains(session.status) ? session.status : "rest" }
        return tiers.compactMap { key, title in
            let items = ordered.filter { tier($0) == key }
            return items.isEmpty ? nil : SessionGroup(id: key, title: title, sessions: items)
        }
    case .project:
        var groups: [SessionGroup] = []
        var index: [String: Int] = [:]
        for session in ordered {
            let key = "\(session.deviceId)\u{0}\(session.cwd)"
            if let position = index[key] { groups[position].sessions.append(session); continue }
            let name = (session.cwd as NSString).lastPathComponent
            index[key] = groups.count
            groups.append(SessionGroup(id: key, title: name.isEmpty ? session.cwd : name, detail: deviceNames[session.deviceId], sessions: [session]))
        }
        return groups
    case .recent:
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: now)
        let bounds: [(String, Date)] = [
            ("今天", today),
            ("昨天", calendar.date(byAdding: .day, value: -1, to: today)!),
            ("前 7 天", calendar.date(byAdding: .day, value: -7, to: today)!),
            ("前 30 天", calendar.date(byAdding: .day, value: -30, to: today)!),
            ("更早", .distantPast),
        ]
        var groups: [SessionGroup] = []
        for session in ordered {
            let date = Date(timeIntervalSince1970: Double(session.updatedAt) / 1000)
            let title = bounds.first { date >= $0.1 }!.0
            if groups.last?.id == title { groups[groups.count - 1].sessions.append(session) }
            else { groups.append(SessionGroup(id: title, title: title, sessions: [session])) }
        }
        return groups
    }
}

struct CompactSessionRow: View {
    let session: APSession
    var showProject = true
    var body: some View {
        HStack(spacing: 10) {
            StatusGlyph(session: session).frame(width: 14)
            (Text(session.title).foregroundStyle(.primary) + Text(showProject ? "  \(projectName)" : "").font(.footnote).foregroundStyle(.tertiary))
                .lineLimit(1)
            Spacer(minLength: 6)
            Text(shortAge(session.updatedAt)).font(.caption).monospacedDigit().foregroundStyle(.secondary)
        }
        .padding(.vertical, 7)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityValue("\(session.agent == "claude" ? "Claude" : "Codex")，\(statusLabel(session.status))")
    }
    private var projectName: String { (session.cwd as NSString).lastPathComponent }
}

struct StatusGlyph: View {
    let session: APSession
    var body: some View {
        switch session.status {
        case "waiting": Image(systemName: "hand.raised.fill").font(.caption).foregroundStyle(.orange)
        case "running": Image(systemName: "circle.fill").font(.system(size: 7)).foregroundStyle(.blue).symbolEffect(.pulse)
        case "error": Image(systemName: "exclamationmark.circle.fill").font(.caption).foregroundStyle(.red)
        default:
            if session.readOnly { Image(systemName: "lock.fill").font(.caption2).foregroundStyle(.tertiary) }
            else { Image(systemName: session.agent == "claude" ? "asterisk" : "chevron.left.forwardslash.chevron.right").font(.caption2).foregroundStyle(.tertiary) }
        }
    }
}

/// 列表中的紧凑时间：刚刚 / 5 分钟 / 3 小时 / 昨天 / 4 天 / 9月12日。
func shortAge(_ milliseconds: Int, now: Date = .now) -> String {
    let date = Date(timeIntervalSince1970: Double(milliseconds) / 1000)
    let seconds = now.timeIntervalSince(date)
    if seconds < 60 { return "刚刚" }
    if seconds < 3600 { return "\(Int(seconds / 60)) 分钟" }
    if Calendar.current.isDateInToday(date) { return "\(Int(seconds / 3600)) 小时" }
    if Calendar.current.isDateInYesterday(date) { return "昨天" }
    if seconds < 7 * 86400 { return "\(max(2, Int(seconds / 86400))) 天" }
    return date.formatted(.dateTime.month(.defaultDigits).day())
}

struct WelcomeView: View {
    @Bindable var model: AppModel
    @State private var recovery = false
    @State private var method: String?
    @State private var confirm = ""
    private var usePassword: Bool { (method ?? (model.passwordEnabled && model.isRegistered ? "password" : "passkey")) == "password" }
    private var newPassword: Bool { usePassword && (recovery || !model.isRegistered) }
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
                    Picker("登录方式", selection: Binding(get: { usePassword ? "password" : "passkey" }, set: { method = $0 })) { Text("通行密钥").tag("passkey"); Text("密码").tag("password") }.pickerStyle(.segmented).labelsHidden()
                    TextField("账号邮箱", text: $model.email).textContentType(.username)
                    if recovery { SecureField("一次性恢复码", text: $model.recoveryCode) }
                    else if !model.isRegistered { SecureField("初始注册凭证", text: $model.bootstrapToken) }
                    if usePassword {
                        SecureField(newPassword ? "新密码（至少 8 个字符）" : "密码", text: $model.password).textContentType(newPassword ? .newPassword : .password)
                        if newPassword { SecureField("确认新密码", text: $confirm).textContentType(.newPassword) }
                    }
                    Button { Task { await submit() } } label: {
                        HStack { if model.isBusy { ProgressView().controlSize(.small) } else { Image(systemName: usePassword ? "key" : "person.badge.key") }; Text(title); Spacer(); Image(systemName: "arrow.right") }.padding(.vertical, 8)
                    }.buttonStyle(.borderedProminent).disabled(model.isBusy || model.email.isEmpty || (usePassword && model.password.isEmpty))
                    HStack { Button("检查连接") { Task { await model.inspectServer() } }; Spacer(); Button(recovery ? "返回登录" : usePassword ? "忘记密码" : "使用恢复码") { recovery.toggle(); model.password = ""; confirm = "" } }.font(.callout)
                }.textFieldStyle(.roundedBorder).padding(30).panelGlass().frame(maxWidth: 460)
                Text("你的设备 · 你的会话 · 你的工作空间").font(.caption).foregroundStyle(.secondary)
            }.padding(30).frame(maxWidth: .infinity).padding(.top, 65)
        }.task { await model.inspectServer() }
    }
    private var title: String {
        if usePassword { return recovery ? "恢复并设置新密码" : model.isRegistered ? "登录" : "创建账号" }
        return recovery ? "恢复并设置通行密钥" : model.isRegistered ? "使用通行密钥登录" : "创建通行密钥"
    }
    private func submit() async {
        guard usePassword else {
            if recovery { await model.recover() } else { await model.login(register: !model.isRegistered) }
            return
        }
        if newPassword {
            guard model.password.count >= 8 else { model.error = "密码至少需要 8 个字符"; return }
            guard model.password == confirm else { model.error = "两次输入的密码不一致"; return }
        }
        await model.passwordAuth(mode: recovery ? "recover" : model.isRegistered ? "login" : "register")
        if model.isAuthenticated { confirm = "" }
    }
}

func statusLabel(_ status: String) -> String { ["idle": "就绪", "running": "进行中", "waiting": "等待审批", "completed": "已完成", "error": "出错", "readonly": "只读"][status] ?? status }

struct SessionDetail: View {
    @Bindable var model: AppModel
    @State private var prompt = ""
    @State private var showLocalHistory = false
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    private var compact: Bool { sizeClass == .compact }
    #else
    private let compact = false
    #endif
    var body: some View {
        if let session = model.currentSession {
            VStack(spacing: 0) {
                if session.readOnly { Label(session.busyReason ?? "该会话正在本地使用，暂以只读模式查看", systemImage: "lock.shield").font(.callout).padding().frame(maxWidth: .infinity).background(.orange.opacity(0.08)) }
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 18) {
                            if model.localHistoryLoading.contains(session.id) { ProgressView("正在读取历史…") }
                            if let failure = model.localHistoryErrors[session.id] {
                                VStack(alignment: .leading, spacing: 8) {
                                    Text("历史读取失败：\(failure)").foregroundStyle(.orange)
                                    Button("重试") { Task { await model.retryLocalHistory(session) } }
                                        .disabled(!model.isConnected || !deviceOnline(session))
                                }
                            }
                            if model.localHistoryBefore[session.id] != nil {
                                Button("加载更早的消息") { Task { await model.loadLocalHistory(session, earlier: true) } }
                                    .disabled(model.localHistoryLoading.contains(session.id) || !model.isConnected || !deviceOnline(session))
                            }
                            if session.source == "local", !deviceOnline(session) || !model.isConnected {
                                Text("等待设备连接，连接恢复后会自动读取历史。").font(.caption).foregroundStyle(.secondary)
                            }
                            ForEach(coalesced(model.events[session.id] ?? []), id: \.id) { message in EventView(envelope: message).id(message.id) }
                            ForEach(model.pendingApprovals.filter { $0.sessionId == session.id }, id: \.id) { approval in ApprovalCard(approval: approval, model: model) }
                            Color.clear.frame(height: 1).id("end")
                        }.padding(compact ? 16 : 24).frame(maxWidth: 900).frame(maxWidth: .infinity)
                    }.onChange(of: model.events[session.id]?.last?.id, initial: true) { _, _ in proxy.scrollTo("end", anchor: .bottom) }
                }
                HStack(alignment: .bottom, spacing: 12) {
                    TextField("继续这个想法…", text: $prompt, axis: .vertical).lineLimit(1...7).textFieldStyle(.plain).padding(10).onSubmit { submit(session) }
                    if session.status == "running" || session.status == "waiting" {
                        Button { Task { await model.perform { _ = try await model.command("session.interrupt", device: session.deviceId, session: session.id) } } } label: { Image(systemName: "stop.fill").padding(8) }.help("中断当前轮次").disabled(session.readOnly || !model.isConnected)
                    } else {
                        Button { submit(session) } label: { Image(systemName: "arrow.up").fontWeight(.semibold).padding(8) }.buttonStyle(.borderedProminent).disabled(prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || session.readOnly || !model.isConnected)
                    }
                }.padding(10).panelGlass().padding(compact ? 12 : 18)
            }
            .navigationTitle(session.title)
            .onChange(of: "\(session.id):\(model.isConnected):\(deviceOnline(session))", initial: true) { _, _ in
                Task { await model.loadHistory(session.id) }
            }
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(compact ? .hidden : .automatic, for: .tabBar)
            #endif
            .toolbar {
                if session.nativeId != nil { Button { showLocalHistory = true } label: { Image(systemName: "clock.arrow.circlepath") }.help("查看完整设备记录").accessibilityLabel("查看完整设备记录") }
                #if os(macOS)
                Text(session.agent.capitalized).font(.caption).foregroundStyle(.secondary)
                #endif
            }
            .sheet(isPresented: $showLocalHistory) { LocalHistoryView(model: model, session: session) }
        } else {
            ContentUnavailableView { Label("在这里，继续创造", systemImage: "sparkles") } description: { Text("选择一个会话，或者开启新的想法。\nClaude 与 Codex，跨设备始终连贯。") }
        }
    }
    private func deviceOnline(_ session: APSession) -> Bool { model.devices.contains { $0.id == session.deviceId && $0.online } }
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
        if let questions = approval.questions, !questions.isEmpty { QuestionCard(approval: approval, questions: questions, model: model) }
        else { toolCard }
    }
    private var toolCard: some View {
        VStack(alignment: .leading, spacing: 15) {
            Label("需要你的许可", systemImage: "hand.raised").font(.headline)
            Text(approval.toolName).font(.system(.body, design: .monospaced))
            Text(approval.input.pretty).font(.system(.caption, design: .monospaced)).lineLimit(12).textSelection(.enabled)
            HStack { Text("有效期至 \(Date(timeIntervalSince1970: Double(approval.expiresAt) / 1000).formatted(date: .omitted, time: .shortened))").font(.caption).foregroundStyle(.secondary); Spacer(); Button("拒绝", role: .destructive) { Task { await model.decide(approval, allow: false) } }; Button("允许这一次") { Task { await model.decide(approval, allow: true) } }.buttonStyle(.borderedProminent) }.disabled(model.isBusy)
        }.padding(22).panelGlass()
    }
}


/// Agent 提问（Claude AskUserQuestion / Codex request_user_input）：选项单选/多选，允许时可填写自定义回答。
struct QuestionCard: View {
    let approval: APApproval
    let questions: [APQuestion]
    @Bindable var model: AppModel
    @State private var picked: [String: [String]] = [:]
    @State private var other: [String: String] = [:]
    private func answer(_ question: APQuestion) -> [String] {
        let text = (other[question.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return (picked[question.id] ?? []) + (text.isEmpty ? [] : [text])
    }
    private var complete: Bool { questions.allSatisfy { !answer($0).isEmpty } }
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Label("Agent 在等你的回答", systemImage: "questionmark.bubble").font(.headline)
            ForEach(questions, id: \.id) { question in
                VStack(alignment: .leading, spacing: 9) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        if let header = question.header, !header.isEmpty { Text(header).font(.caption2.weight(.medium)).padding(.horizontal, 6).padding(.vertical, 2).background(.secondary.opacity(0.12), in: Capsule()) }
                        Text(question.question).font(.callout.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                        if question.multiSelect == true { Text("可多选").font(.caption).foregroundStyle(.secondary) }
                    }
                    ForEach(question.options, id: \.label) { option in
                        let active = picked[question.id]?.contains(option.label) == true
                        Button { toggle(question, option.label) } label: {
                            HStack(alignment: .top, spacing: 10) {
                                Image(systemName: question.multiSelect == true ? (active ? "checkmark.square.fill" : "square") : (active ? "largecircle.fill.circle" : "circle")).foregroundStyle(active ? Color.accentColor : .secondary)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(option.label).foregroundStyle(.primary)
                                    if let detail = option.description, !detail.isEmpty { Text(detail).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
                                }
                                Spacer(minLength: 0)
                            }.padding(10).background(active ? Color.accentColor.opacity(0.1) : .secondary.opacity(0.05), in: RoundedRectangle(cornerRadius: 12)).contentShape(Rectangle())
                        }.buttonStyle(.plain)
                    }
                    if question.allowOther == true || question.options.isEmpty {
                        TextField(question.options.isEmpty ? "输入你的回答…" : "其他回答…", text: Binding(get: { other[question.id] ?? "" }, set: { value in
                            other[question.id] = value
                            if !value.isEmpty && question.multiSelect != true { picked[question.id] = [] }
                        }), axis: .vertical).lineLimit(1...4).textFieldStyle(.roundedBorder)
                    }
                }
            }
            HStack {
                Text("有效期至 \(Date(timeIntervalSince1970: Double(approval.expiresAt) / 1000).formatted(date: .omitted, time: .shortened))").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("跳过") { Task { await model.decide(approval, allow: false) } }
                Button("提交回答") { Task { await model.decide(approval, allow: true, answers: Dictionary(uniqueKeysWithValues: questions.map { ($0.id, answer($0)) })) } }.buttonStyle(.borderedProminent).disabled(!complete)
            }.disabled(model.isBusy)
        }.padding(22).panelGlass()
    }
    private func toggle(_ question: APQuestion, _ label: String) {
        var chosen = picked[question.id] ?? []
        if question.multiSelect == true { if let index = chosen.firstIndex(of: label) { chosen.remove(at: index) } else { chosen.append(label) } }
        else { chosen = chosen == [label] ? [] : [label]; other[question.id] = "" }
        picked[question.id] = chosen
    }
}

struct DeviceQuotaView: View {
    @Bindable var model: AppModel
    /// 作为 iOS 标签页嵌入时不显示「完成」，改为提供连接设备入口。
    var embedded = false
    @Environment(\.dismiss) private var dismiss
    @State private var refreshing = Set<String>()
    @State private var showPair = false
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
            .overlay { if model.devices.isEmpty { ContentUnavailableView { Label("还没有设备", systemImage: "desktopcomputer") } description: { Text("在电脑上运行 Daemon 并完成配对。") } actions: { Button("连接设备") { showPair = true; Task { await model.pair() } }.buttonStyle(.borderedProminent) } } }
            .refreshable { await model.reload() }
            .navigationTitle(embedded ? "设备" : "设备与订阅额度")
            .toolbar {
                if embedded { ToolbarItem(placement: .primaryAction) { Button { showPair = true; Task { await model.pair() } } label: { Image(systemName: "plus") }.accessibilityLabel("连接设备") } }
                else { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
            }
            .sheet(isPresented: $showPair) { PairingView(model: model) }
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
