import Foundation

func timelineStateIsCurrent(_ event: APEnvelope, lastSequence: Int) -> Bool {
    event.seq.map { $0 >= lastSequence } ?? true
}

/// Replay may arrive after a newer live event. Relay sequence is authoritative.
func mergedTimeline(_ current: [APEnvelope], _ incoming: [APEnvelope]) -> [APEnvelope] {
    var byId = Dictionary(current.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
    for event in incoming { byId[event.id] = event }
    return byId.values.sorted { lhs, rhs in
        if let left = lhs.seq, let right = rhs.seq, left != right { return left < right }
        if (lhs.seq == nil) != (rhs.seq == nil) { return lhs.seq == nil }
        if lhs.ts != rhs.ts { return lhs.ts < rhs.ts }
        return lhs.id < rhs.id
    }
}

func coalesced(_ events: [APEnvelope]) -> [APEnvelope] {
    var result: [APEnvelope] = []
    var canMerge = false
    var turnStart = 0
    for item in events {
        guard item.type == "session.event" else { continue }
        let kind = item.payload["kind"].stringValue ?? ""
        if kind == "turn.start" || kind == "turn.end" {
            canMerge = false
            turnStart = result.count
            continue
        }
        if kind == "usage" { continue }
        if canMerge, (kind == "message.delta" || kind == "thinking.delta"), let last = result.last,
           last.payload["kind"].stringValue == kind,
           last.payload["messageId"] == item.payload["messageId"], last.payload["role"] == item.payload["role"] {
            var combined = last
            var payload = last.payload.objectValue ?? [:]
            payload["text"] = .string((last.payload["text"].stringValue ?? "") + (item.payload["text"].stringValue ?? ""))
            combined.payload = .object(payload)
            result[result.count - 1] = combined
        } else if kind == "message.done", let index = result.indices.reversed().first(where: { index in
            index >= turnStart && result[index].payload["kind"].stringValue == "message.delta" &&
            result[index].payload["messageId"] == item.payload["messageId"] && result[index].payload["role"] == item.payload["role"] &&
            (item.payload["messageId"].stringValue != nil || (canMerge && index == result.count - 1))
        }) {
            if item.payload["text"].stringValue?.isEmpty == false {
                var complete = item
                complete.id = result[index].id
                result[index] = complete
            }
        } else { result.append(item) }
        canMerge = kind == "message.delta" || kind == "thinking.delta"
    }
    return result
}
