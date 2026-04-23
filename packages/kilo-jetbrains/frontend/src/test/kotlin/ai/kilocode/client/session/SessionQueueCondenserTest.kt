package ai.kilocode.client.session

import ai.kilocode.rpc.dto.ChatEventDto
import junit.framework.TestCase

class SessionQueueCondenserTest : TestCase() {

    private val condenser = SessionQueueCondenser()

    private fun delta(msg: String, part: String, text: String) =
        ChatEventDto.PartDelta("ses", msg, part, "text", text)

    private fun nonDelta(msg: String) =
        ChatEventDto.TurnOpen(msg)

    fun `test empty list returns empty`() {
        assertEquals(emptyList<ChatEventDto>(), condenser.condense(emptyList()))
    }

    fun `test single event returned unchanged`() {
        val event = delta("m1", "p1", "hi")
        assertEquals(listOf(event), condenser.condense(listOf(event)))
    }

    fun `test two deltas for same part are merged`() {
        val result = condenser.condense(listOf(
            delta("m1", "p1", "hello "),
            delta("m1", "p1", "world"),
        ))
        assertEquals(1, result.size)
        assertEquals("hello world", (result[0] as ChatEventDto.PartDelta).delta)
    }

    fun `test many deltas for same part are all merged`() {
        val result = condenser.condense(listOf(
            delta("m1", "p1", "a"),
            delta("m1", "p1", "b"),
            delta("m1", "p1", "c"),
        ))
        assertEquals(1, result.size)
        assertEquals("abc", (result[0] as ChatEventDto.PartDelta).delta)
    }

    fun `test deltas for different parts are kept separate`() {
        val result = condenser.condense(listOf(
            delta("m1", "p1", "foo"),
            delta("m1", "p2", "bar"),
        ))
        assertEquals(2, result.size)
        assertEquals("foo", (result[0] as ChatEventDto.PartDelta).delta)
        assertEquals("bar", (result[1] as ChatEventDto.PartDelta).delta)
    }

    fun `test non-text field deltas are not merged`() {
        val d1 = ChatEventDto.PartDelta("ses", "m1", "p1", "tool_call", "chunk1")
        val d2 = ChatEventDto.PartDelta("ses", "m1", "p1", "tool_call", "chunk2")
        val result = condenser.condense(listOf(d1, d2))
        assertEquals(2, result.size)
    }

    fun `test non-delta event flushes pending deltas before it`() {
        val barrier = nonDelta("turn1")
        val result = condenser.condense(listOf(
            delta("m1", "p1", "x"),
            delta("m1", "p1", "y"),
            barrier,
            delta("m1", "p1", "z"),
        ))
        assertEquals(3, result.size)
        assertEquals("xy", (result[0] as ChatEventDto.PartDelta).delta)
        assertEquals(barrier, result[1])
        assertEquals("z", (result[2] as ChatEventDto.PartDelta).delta)
    }

    fun `test deltas after barrier are merged independently`() {
        val result = condenser.condense(listOf(
            delta("m1", "p1", "a"),
            nonDelta("t"),
            delta("m1", "p1", "b"),
            delta("m1", "p1", "c"),
        ))
        assertEquals(3, result.size)
        assertEquals("a", (result[0] as ChatEventDto.PartDelta).delta)
        assertEquals("bc", (result[2] as ChatEventDto.PartDelta).delta)
    }

    fun `test deltas for different messages are kept separate`() {
        val result = condenser.condense(listOf(
            delta("m1", "p1", "hi"),
            delta("m2", "p1", "there"),
        ))
        assertEquals(2, result.size)
        assertEquals("hi", (result[0] as ChatEventDto.PartDelta).delta)
        assertEquals("there", (result[1] as ChatEventDto.PartDelta).delta)
    }

    fun `test merged delta uses session and part ids from last event`() {
        val result = condenser.condense(listOf(
            delta("m1", "p1", "first"),
            delta("m1", "p1", "second"),
        )) as List<ChatEventDto.PartDelta>
        assertEquals("ses", result[0].sessionID)
        assertEquals("m1", result[0].messageID)
        assertEquals("p1", result[0].partID)
    }
}
