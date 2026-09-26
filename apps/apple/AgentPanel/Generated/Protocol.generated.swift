// Generated from packages/protocol Zod schemas via protocol.schema.json. DO NOT EDIT.
import Foundation

public struct APAgentCapability: Codable, Sendable {
    public var kind: String
    public var installed: Bool
    public var version: String?
    public var authenticated: Bool?
    public var models: [String]?
    public var authMessage: String?
    public init(kind: String, installed: Bool, version: String? = nil, authenticated: Bool? = nil, models: [String]? = nil, authMessage: String? = nil) {
        self.kind = kind
        self.installed = installed
        self.version = version
        self.authenticated = authenticated
        self.models = models
        self.authMessage = authMessage
    }
}

public struct APDevice: Codable, Sendable {
    public var id: String
    public var name: String
    public var platform: String
    public var hostname: String?
    public var online: Bool
    public var agents: [APAgentCapability]
    public var lastSeen: Int
    public init(id: String, name: String, platform: String, hostname: String? = nil, online: Bool, agents: [APAgentCapability], lastSeen: Int) {
        self.id = id
        self.name = name
        self.platform = platform
        self.hostname = hostname
        self.online = online
        self.agents = agents
        self.lastSeen = lastSeen
    }
}

public struct APUsage: Codable, Sendable {
    public var inputTokens: Double
    public var outputTokens: Double
    public var cacheReadTokens: Double
    public var cacheWriteTokens: Double
    public var costUsd: Double?
    public var model: String?
    public var pricingVersion: String?
    public var turns: Int?
    public var activeMs: Double?
    public init(inputTokens: Double, outputTokens: Double, cacheReadTokens: Double, cacheWriteTokens: Double, costUsd: Double? = nil, model: String? = nil, pricingVersion: String? = nil, turns: Int? = nil, activeMs: Double? = nil) {
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cacheReadTokens = cacheReadTokens
        self.cacheWriteTokens = cacheWriteTokens
        self.costUsd = costUsd
        self.model = model
        self.pricingVersion = pricingVersion
        self.turns = turns
        self.activeMs = activeMs
    }
}

public struct APUsageDay: Codable, Sendable {
    public var date: String
    public var usage: APUsage
    public init(date: String, usage: APUsage) {
        self.date = date
        self.usage = usage
    }
}

public struct APSession: Codable, Sendable {
    public var id: String
    public var deviceId: String
    public var agent: String
    public var cwd: String
    public var title: String
    public var status: String
    public var source: String
    public var nativeId: String?
    public var createdAt: Int
    public var updatedAt: Int
    public var readOnly: Bool
    public var busyReason: String?
    public var usage: APUsage?
    public var usageByDay: [APUsageDay]?
    public init(id: String, deviceId: String, agent: String, cwd: String, title: String, status: String, source: String, nativeId: String? = nil, createdAt: Int, updatedAt: Int, readOnly: Bool, busyReason: String? = nil, usage: APUsage? = nil, usageByDay: [APUsageDay]? = nil) {
        self.id = id
        self.deviceId = deviceId
        self.agent = agent
        self.cwd = cwd
        self.title = title
        self.status = status
        self.source = source
        self.nativeId = nativeId
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.readOnly = readOnly
        self.busyReason = busyReason
        self.usage = usage
        self.usageByDay = usageByDay
    }
}

public struct APError: Codable, Sendable {
    public var code: String
    public var message: String
    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }
}

public struct APSessionEvent: Codable, Sendable {
    public var kind: String
    public var role: String?
    public var text: String?
    public var messageId: String?
    public var toolCallId: String?
    public var toolName: String?
    public var input: JSONValue?
    public var output: JSONValue?
    public var diff: String?
    public var usage: APUsage?
    public var error: APError?
    public var turnId: String?
    public var nativeId: String?
    public var model: String?
    public init(kind: String, role: String? = nil, text: String? = nil, messageId: String? = nil, toolCallId: String? = nil, toolName: String? = nil, input: JSONValue? = nil, output: JSONValue? = nil, diff: String? = nil, usage: APUsage? = nil, error: APError? = nil, turnId: String? = nil, nativeId: String? = nil, model: String? = nil) {
        self.kind = kind
        self.role = role
        self.text = text
        self.messageId = messageId
        self.toolCallId = toolCallId
        self.toolName = toolName
        self.input = input
        self.output = output
        self.diff = diff
        self.usage = usage
        self.error = error
        self.turnId = turnId
        self.nativeId = nativeId
        self.model = model
    }
}

public struct APApproval: Codable, Sendable {
    public var id: String
    public var deviceId: String
    public var sessionId: String
    public var toolCallId: String?
    public var toolName: String
    public var input: JSONValue
    public var createdAt: Int
    public var expiresAt: Int
    public var status: String
    public var reason: String?
    public init(id: String, deviceId: String, sessionId: String, toolCallId: String? = nil, toolName: String, input: JSONValue, createdAt: Int, expiresAt: Int, status: String, reason: String? = nil) {
        self.id = id
        self.deviceId = deviceId
        self.sessionId = sessionId
        self.toolCallId = toolCallId
        self.toolName = toolName
        self.input = input
        self.createdAt = createdAt
        self.expiresAt = expiresAt
        self.status = status
        self.reason = reason
    }
}

public struct APDirectoryEntry: Codable, Sendable {
    public var name: String
    public var path: String
    public init(name: String, path: String) {
        self.name = name
        self.path = path
    }
}

public struct APDirectoryListing: Codable, Sendable {
    public var path: String
    public var parent: String?
    public var entries: [APDirectoryEntry]
    public var roots: [String]?
    public var recent: [String]?
    public init(path: String, parent: String? = nil, entries: [APDirectoryEntry], roots: [String]? = nil, recent: [String]? = nil) {
        self.path = path
        self.parent = parent
        self.entries = entries
        self.roots = roots
        self.recent = recent
    }
}

public struct APNotificationPreferences: Codable, Sendable {
    public var deviceId: String?
    public var sessionId: String?
    public var approvals: Bool
    public var completed: Bool
    public var errors: Bool
    public var waiting: Bool
    public var showContent: Bool
    public init(deviceId: String? = nil, sessionId: String? = nil, approvals: Bool, completed: Bool, errors: Bool, waiting: Bool, showContent: Bool) {
        self.deviceId = deviceId
        self.sessionId = sessionId
        self.approvals = approvals
        self.completed = completed
        self.errors = errors
        self.waiting = waiting
        self.showContent = showContent
    }
}

public struct APStatsQuery: Codable, Sendable {
    public var deviceId: String?
    public var agent: String?
    public var project: String?
    public var from: Int?
    public var to: Int?
    public var groupBy: String?
    public init(deviceId: String? = nil, agent: String? = nil, project: String? = nil, from: Int? = nil, to: Int? = nil, groupBy: String? = nil) {
        self.deviceId = deviceId
        self.agent = agent
        self.project = project
        self.from = from
        self.to = to
        self.groupBy = groupBy
    }
}

public struct APStatsBucket: Codable, Sendable {
    public var key: String
    public var sessions: Double
    public var usage: APUsage
    public init(key: String, sessions: Double, usage: APUsage) {
        self.key = key
        self.sessions = sessions
        self.usage = usage
    }
}

public struct APStatsResult: Codable, Sendable {
    public var sessions: Double
    public var usage: APUsage
    public var buckets: [APStatsBucket]
    public init(sessions: Double, usage: APUsage, buckets: [APStatsBucket]) {
        self.sessions = sessions
        self.usage = usage
        self.buckets = buckets
    }
}

public struct APEnvelope: Codable, Sendable {
    public var v: Double
    public var id: String
    public var deviceId: String?
    public var sessionId: String?
    public var seq: Int?
    public var ts: Int
    public var type: String
    public var payload: JSONValue
    public init(v: Double, id: String, deviceId: String? = nil, sessionId: String? = nil, seq: Int? = nil, ts: Int, type: String, payload: JSONValue) {
        self.v = v
        self.id = id
        self.deviceId = deviceId
        self.sessionId = sessionId
        self.seq = seq
        self.ts = ts
        self.type = type
        self.payload = payload
    }
}

public enum JSONValue: Codable, Sendable, Equatable {
    case null, bool(Bool), number(Double), string(String), array([JSONValue]), object([String: JSONValue])
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([JSONValue].self) { self = .array(v) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        }
    }
    public var stringValue: String? { if case .string(let v) = self { return v }; return nil }
    public var numberValue: Double? { if case .number(let v) = self { return v }; return nil }
    public var boolValue: Bool? { if case .bool(let v) = self { return v }; return nil }
    public var arrayValue: [JSONValue]? { if case .array(let v) = self { return v }; return nil }
    public var objectValue: [String: JSONValue]? { if case .object(let v) = self { return v }; return nil }
    public subscript(_ key: String) -> JSONValue { objectValue?[key] ?? .null }
    public func decoded<T: Decodable>(_ type: T.Type) throws -> T { try JSONDecoder().decode(type, from: JSONEncoder().encode(self)) }
    public static func encoded<T: Encodable>(_ value: T) throws -> JSONValue { try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value)) }
    public var pretty: String { let e = JSONEncoder(); e.outputFormatting = [.prettyPrinted, .sortedKeys]; return (try? String(data: e.encode(self), encoding: .utf8)) ?? "" }
}
