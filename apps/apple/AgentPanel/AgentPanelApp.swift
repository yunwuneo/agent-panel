import SwiftUI
import UserNotifications
#if os(macOS)
import AppKit
#else
import UIKit
#endif

@main struct AgentPanelApp: App {
    @State private var model = AppModel()
    #if os(macOS)
    @NSApplicationDelegateAdaptor(PanelAppDelegate.self) private var delegate
    #else
    @UIApplicationDelegateAdaptor(PanelAppDelegate.self) private var delegate
    #endif
    var body: some Scene {
        WindowGroup {
            RootView(model: model)
                .task { NotificationBridge.shared.model = model; await model.restore() }
                #if os(macOS)
                .frame(minWidth: 950, minHeight: 650)
                #endif
        }
        #if os(macOS)
        MenuBarExtra("AgentPanel \(model.pendingApprovals.count)", systemImage: "square.stack.3d.up") {
            if model.pendingApprovals.isEmpty { Text("暂无待审批请求") }
            ForEach(model.pendingApprovals, id: \.id) { approval in
                if approval.questions?.isEmpty == false {
                    Button("回答问题：\(approval.questions?.first?.question ?? "")") { model.selectedSession = approval.sessionId; NSApp.activate(ignoringOtherApps: true); NSApp.windows.first?.makeKeyAndOrderFront(nil) }
                } else {
                    Menu(approval.toolName) {
                        Button("允许") { Task { await model.decide(approval, allow: true) } }
                        Button("拒绝") { Task { await model.decide(approval, allow: false) } }
                    }
                }
            }
            Divider()
            Button("打开 AgentPanel") { NSApp.activate(ignoringOtherApps: true); NSApp.windows.first?.makeKeyAndOrderFront(nil) }
        }
        #endif
    }
}

@MainActor final class NotificationBridge: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationBridge()
    weak var model: AppModel?
    func configure() {
        let allow = UNNotificationAction(identifier: "ALLOW", title: "允许", options: [.authenticationRequired])
        let deny = UNNotificationAction(identifier: "DENY", title: "拒绝", options: [.authenticationRequired])
        let category = UNNotificationCategory(identifier: "AGENTPANEL_APPROVAL", actions: [allow, deny], intentIdentifiers: [], options: [])
        UNUserNotificationCenter.current().setNotificationCategories([category])
        UNUserNotificationCenter.current().delegate = self
    }
    func requestPermission() async throws {
        guard try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) else { throw ClientError.message("请在系统设置中允许通知") }
        #if os(macOS)
        NSApplication.shared.registerForRemoteNotifications()
        #else
        UIApplication.shared.registerForRemoteNotifications()
        #endif
    }
    func register(_ token: Data) async {
        guard let model, model.isAuthenticated else { return }
        let value = token.map { String(format: "%02x", $0) }.joined()
        #if os(macOS)
        let platform = "macos"
        #else
        let platform = "ios"
        #endif
        await model.perform { _ = try await model.api.request("/api/push/apns", method: "POST", body: .object(["token": .string(value), "platform": .string(platform)])) }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping @Sendable () -> Void) {
        let id = response.notification.request.content.userInfo["approvalId"] as? String
        let sessionId = response.notification.request.content.userInfo["sessionId"] as? String
        let action = response.actionIdentifier
        Task { @MainActor in
            defer { completionHandler() }
            if (action == "ALLOW" || action == "DENY"), let id {
                // A notification action can launch without constructing any SwiftUI view.
                // Recover the refresh credential directly from Keychain in that case.
                let client = self.model?.api ?? RelayClient()
                do { _ = try await client.request("/api/approvals/\(id)/decision", method: "POST", body: .object(["decision": .string(action == "ALLOW" ? "allow" : "deny")])) }
                catch {
                    self.model?.error = error.localizedDescription
                    let content = UNMutableNotificationContent()
                    content.title = "审批未提交"
                    content.body = "请打开 AgentPanel 检查连接并重试。"
                    content.userInfo = ["approvalId": id, "sessionId": sessionId ?? ""]
                    try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "approval-retry-\(id)", content: content, trigger: nil))
                }
            } else {
                await self.model?.reload()
                if let sessionId { self.model?.selectedSession = sessionId }
            }
        }
    }
}

#if os(macOS)
@MainActor final class PanelAppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) { NotificationBridge.shared.configure() }
    func application(_ application: NSApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) { Task { await NotificationBridge.shared.register(deviceToken) } }
    func application(_ application: NSApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) { NotificationBridge.shared.model?.error = "推送尚未可用：\(error.localizedDescription)" }
}
#else
@MainActor final class PanelAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool { NotificationBridge.shared.configure(); return true }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) { Task { await NotificationBridge.shared.register(deviceToken) } }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) { NotificationBridge.shared.model?.error = "推送尚未可用：\(error.localizedDescription)" }
}
#endif
