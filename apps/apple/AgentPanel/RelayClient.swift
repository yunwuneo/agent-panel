import Foundation
import Security

enum ClientError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}

enum TokenVault {
    static let service = "dev.agentpanel.credentials"
    static func read(_ name: String) -> String? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: name, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
    static func save(_ value: String?, name: String) {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: name]
        SecItemDelete(query as CFDictionary)
        if let value {
            var item = query
            item[kSecValueData as String] = Data(value.utf8)
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            SecItemAdd(item as CFDictionary, nil)
        }
    }
}

@MainActor final class RelayClient {
    /// 本机、私有网段（RFC 1918 / ULA）、链路本地地址及 .local 主机名允许明文 HTTP。
    nonisolated static func isLocalNetworkHost(_ hostname: String) -> Bool {
        let host = hostname.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if host == "localhost" || host.hasSuffix(".localhost") || host.hasSuffix(".local") { return true }
        let octets = host.split(separator: ".", omittingEmptySubsequences: false).map { Int($0) }
        if octets.count == 4, octets.allSatisfy({ ($0 ?? -1) >= 0 && ($0 ?? 256) <= 255 }) {
            let a = octets[0]!, b = octets[1]!
            return a == 127 || a == 10 || (a == 172 && (16...31).contains(b)) || (a == 192 && b == 168) || (a == 169 && b == 254)
        }
        return host == "::1" || host.range(of: "^f[cd][0-9a-f]{2}:", options: .regularExpression) != nil
            || host.range(of: "^fe[89ab][0-9a-f]:", options: .regularExpression) != nil
    }
    var origin = UserDefaults.standard.string(forKey: "relayOrigin") ?? "http://localhost:8787"
    var accessToken: String?
    private var refreshTask: Task<Void, Error>?
    var refreshToken: String? { TokenVault.read("refresh:\(origin)") }
    func acceptTokens(_ value: JSONValue) {
        accessToken = value["accessToken"].stringValue
        if let refresh = value["refreshToken"].stringValue { TokenVault.save(refresh, name: "refresh:\(origin)") }
    }
    func clearTokens() { accessToken = nil; TokenVault.save(nil, name: "refresh:\(origin)") }
    func request(_ path: String, method: String = "GET", body: JSONValue? = nil, authenticated: Bool = true, retry: Bool = true) async throws -> JSONValue {
        guard let base = URL(string: origin), ["http", "https"].contains(base.scheme ?? ""), let url = URL(string: path, relativeTo: base) else { throw ClientError.message("请输入有效的 Relay 地址") }
        if base.scheme == "http", !Self.isLocalNetworkHost(base.host ?? "") { throw ClientError.message("远程 Relay 必须使用 HTTPS") }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("native", forHTTPHeaderField: "X-AgentPanel-Client")
        if authenticated, let accessToken { request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization") }
        if let body { request.httpBody = try JSONEncoder().encode(body) }
        let data: Data, response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch let error as URLError where error.code == .networkConnectionLost && path != "/api/auth/refresh" {
            // 服务器关闭空闲 keep-alive 连接后 URLSession 仍可能复用它，POST 不会自动重试；
            // refresh token 轮换带重用检测，重发可能吊销登录，故排除。
            (data, response) = try await URLSession.shared.data(for: request)
        }
        guard let http = response as? HTTPURLResponse else { throw ClientError.message("Relay 返回了无效响应") }
        if http.statusCode == 401 && authenticated && retry && refreshToken != nil {
            try await refresh()
            return try await self.request(path, method: method, body: body, authenticated: true, retry: false)
        }
        let value = (try? JSONDecoder().decode(JSONValue.self, from: data)) ?? .null
        guard (200..<300).contains(http.statusCode) else {
            throw ClientError.message(value["error"]["message"].stringValue ?? value["message"].stringValue ?? "请求失败（\(http.statusCode)）")
        }
        return value
    }
    func refresh() async throws {
        if let refreshTask { return try await refreshTask.value }
        let task = Task { @MainActor in
            guard let token = refreshToken else { throw ClientError.message("请先登录") }
            let result = try await request("/api/auth/refresh", method: "POST", body: .object(["refreshToken": .string(token), "native": .bool(true)]), authenticated: false)
            acceptTokens(result)
        }
        refreshTask = task
        defer { refreshTask = nil }
        try await task.value
    }
    func socket() async throws -> URLSessionWebSocketTask {
        let response = try await request("/api/ws-ticket", method: "POST", body: .object([:]))
        guard let ticket = response["ticket"].stringValue, var url = URLComponents(string: origin) else { throw ClientError.message("无法获取连接凭证") }
        url.scheme = url.scheme == "https" ? "wss" : "ws"
        url.path = "/ws"
        url.queryItems = [URLQueryItem(name: "ticket", value: ticket)]
        guard let target = url.url else { throw ClientError.message("连接地址无效") }
        let task = URLSession.shared.webSocketTask(with: target)
        task.resume()
        return task
    }
}

extension Data {
    init?(base64URL: String) {
        var value = base64URL.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        value += String(repeating: "=", count: (4 - value.count % 4) % 4)
        self.init(base64Encoded: value)
    }
    var base64URL: String { base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
}
