import Foundation

enum EnvelopeFactory {
    static func make(_ type: String, payload: JSONValue = .object([:]), device: String? = nil, session: String? = nil) -> APEnvelope {
        APEnvelope(v: 1, id: UUID().uuidString, deviceId: device, sessionId: session, ts: Int(Date().timeIntervalSince1970 * 1000), type: type, payload: payload)
    }
}
