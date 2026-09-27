import Foundation

@main struct ProtocolChecks {
    static func main() throws {
        let file = URL(fileURLWithPath: CommandLine.arguments[1])
        let envelope = try JSONDecoder().decode(APEnvelope.self, from: Data(contentsOf: file))
        let event = try envelope.payload.decoded(APSessionEvent.self)
        precondition(envelope.seq == 42 && envelope.sessionId == "session_contract")
        precondition(event.text == "你好，Liquid Glass 🌊")
        precondition(event.input?["nullable"] == .null)
        let roundtrip = try JSONDecoder().decode(APEnvelope.self, from: JSONEncoder().encode(envelope))
        precondition(roundtrip.payload == envelope.payload)
        let quotaEnvelope = try JSONDecoder().decode(APEnvelope.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[3])))
        let device = try quotaEnvelope.payload.decoded(APDevice.self)
        precondition(device.agents[0].executionAvailable == false)
        precondition(device.agents[0].quota?.windows[0].usedPercent == 7.5)
        precondition(device.agents[0].quota?.windows[0].resetsAt == 1791050259000)
        precondition(device.agents[0].quota?.windows[0].windowMinutes == 10080)
        let quotaRoundtrip = try JSONDecoder().decode(APDevice.self, from: JSONEncoder().encode(device))
        precondition(quotaRoundtrip.agents[0].quota?.status == "available")
        let listing = try JSONDecoder().decode(APDirectoryListing.self, from: Data("{\"path\":\"/\",\"parent\":null,\"entries\":[{\"name\":\"工作\",\"path\":\"/工作\"}]}".utf8))
        precondition(listing.parent == nil && listing.entries[0].name == "工作")
        let wideJSON = try JSONDecoder().decode(JSONValue.self, from: Data("[true,1,\"text\",null,{\"nested\":[1.25,false]}]".utf8))
        let wideRoundtrip = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(wideJSON))
        precondition(wideRoundtrip == wideJSON)
        func sample(_ seq: Int, _ kind: String, _ text: String = "") -> APEnvelope {
            var item = EnvelopeFactory.make("session.event", payload: .object(["kind": .string(kind), "text": .string(text)]))
            item.id = "event_\(seq)"; item.seq = seq
            return item
        }
        let first = sample(1, "message.delta", "第一轮")
        let end = sample(2, "turn.end")
        let start = sample(3, "turn.start")
        let second = sample(4, "message.delta", "第二轮")
        let tail = sample(5, "message.delta", "。")
        let timeline = mergedTimeline([second, tail], [first, end, start, second])
        precondition(timeline.map { $0.seq! } == [1, 2, 3, 4, 5])
        let bubbles = coalesced(timeline)
        precondition(bubbles.count == 2 && bubbles[0].payload["text"].stringValue == "第一轮" && bubbles[1].payload["text"].stringValue == "第二轮。")
        var lateApproval = sample(2, "approval.request")
        lateApproval.type = "approval.request"
        precondition(!timelineStateIsCurrent(lateApproval, lastSequence: 5), "An overlapping replay must not restore a completed approval")
        print("Swift: out-of-order replay, duplicate delivery and cross-turn delta boundaries passed")
        let outgoing = EnvelopeFactory.make("session.send", payload: .object(["prompt": .string("Swift → TS 🌊")]), device: "device_contract", session: "session_contract")
        let roots = EnvelopeFactory.make("fs.listDir", payload: .object(["path": .string("")]), device: "device_contract")
        try JSONEncoder().encode([outgoing, roots]).write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
        print("Swift: TS envelope, Unicode, recursive JSON, nullable root and roundtrip passed")
    }
}
