package ai.kilocode.client.session

import ai.kilocode.rpc.dto.ChatEventDto

/**
 * Reduces a batch of queued [ChatEventDto] events before they are flushed to
 * the model, by merging consecutive text [ChatEventDto.PartDelta] events that
 * target the same part.
 *
 * ## Algorithm
 *
 * Events are scanned in arrival order. A temporary `deltas` map accumulates
 * mergeable text deltas keyed by `(sessionId, messageId, partId, field)`.
 * When a non-delta event arrives it acts as a **barrier** — all accumulated
 * deltas are flushed into the output before the barrier event is appended.
 * This preserves the original event ordering while collapsing N text chunks
 * into one per part per batch.
 *
 * ## What is merged
 *
 * - `ChatEventDto.PartDelta` where `field == "text"` and same
 *   `(sessionId, messageId, partId, field)` key.
 *
 * ## What is not merged
 *
 * - `PartDelta` for non-text fields
 * - `PartUpdated`, `MessageUpdated`, `SessionStatusChanged`, `SessionDiffChanged`
 *   and all other event types — these pass through unchanged
 */
internal class SessionQueueCondenser {

    fun condense(events: List<ChatEventDto>): List<ChatEventDto> {
        if (events.size < 2) return events
        val out = mutableListOf<ChatEventDto>()
        val deltas = LinkedHashMap<String, ChatEventDto.PartDelta>()

        fun drain() {
            if (deltas.isEmpty()) return
            out.addAll(deltas.values)
            deltas.clear()
        }

        for (event in events) {
            val delta = event as? ChatEventDto.PartDelta
            val key = delta?.key()
            if (key == null) {
                drain()
                out.add(event)
                continue
            }
            val prev = deltas[key]
            deltas[key] = if (prev != null) prev.merge(delta) else delta
        }

        drain()
        return out
    }

    private fun ChatEventDto.PartDelta.key(): String? {
        if (field != "text") return null
        return "$sessionID:$messageID:$partID:$field"
    }

    private fun ChatEventDto.PartDelta.merge(next: ChatEventDto.PartDelta): ChatEventDto.PartDelta =
        ChatEventDto.PartDelta(next.sessionID, next.messageID, next.partID, next.field, delta + next.delta)
}
