package ai.kilocode.client.session.ui

import ai.kilocode.rpc.dto.ModelSelectionDto
import com.intellij.testFramework.fixtures.BasePlatformTestCase

@Suppress("UnstableApiUsage")
class ModelPickerTest : BasePlatformTestCase() {

    fun `test smart filter matches split version text`() {
        assertTrue(ModelSearch.matches("gpt 54", "Chat GPT 5.4"))
    }

    fun `test smart filter matches delimited version text`() {
        assertTrue(ModelSearch.matches("gpt5", "gpt-5"))
    }

    fun `test smart filter matches word acronym`() {
        assertTrue(ModelSearch.matches("clso", "Claude Sonnet"))
    }

    fun `test section order starts with favorites and recommended`() {
        val rows = modelPickerRows(listOf(
            item("gpt-4o", "GPT 4o", "openai", "OpenAI"),
            item("claude", "Claude Sonnet", "anthropic", "Anthropic", 1.0),
            item("auto", "Kilo Auto", "kilo", "Kilo", 0.0),
        ), listOf(ModelSelectionDto("openai", "gpt-4o")), "")

        assertEquals("Favorites", (rows[0] as ModelPickerRow.Header).label)
        assertEquals("openai/gpt-4o", (rows[1] as ModelPickerRow.Entry).item.key)
        assertEquals("Recommended", (rows[2] as ModelPickerRow.Header).label)
        assertEquals("kilo/auto", (rows[3] as ModelPickerRow.Entry).item.key)
        assertEquals("anthropic/claude", (rows[4] as ModelPickerRow.Entry).item.key)
    }

    fun `test favorites are hidden while filtering`() {
        val rows = modelPickerRows(listOf(
            item("gpt-4o", "GPT 4o", "openai", "OpenAI"),
            item("claude", "Claude Sonnet", "anthropic", "Anthropic"),
        ), listOf(ModelSelectionDto("openai", "gpt-4o")), "gpt")


        assertFalse(rows.any { it is ModelPickerRow.Header && it.label == "Favorites" })
        assertEquals("openai/gpt-4o", (rows.filterIsInstance<ModelPickerRow.Entry>().single()).item.key)
    }

    fun `test kilo provider group is first and other providers keep source order`() {
        val rows = modelPickerRows(listOf(
            item("gpt", "GPT", "openai", "OpenAI"),
            item("auto", "Auto", "kilo", "Kilo"),
            item("claude", "Claude", "anthropic", "Anthropic"),
        ), emptyList(), "")

        assertEquals(listOf("Kilo", "OpenAI", "Anthropic"), rows.filterIsInstance<ModelPickerRow.Header>().map { it.label })
    }

    fun `test list model navigation skips headers`() {
        val model = ModelPickerListModel()
        model.setRows(listOf(
            ModelPickerRow.Header("Recommended"),
            ModelPickerRow.Entry(item("a", "A", "openai", "OpenAI"), false),
            ModelPickerRow.Header("Anthropic"),
            ModelPickerRow.Entry(item("b", "B", "anthropic", "Anthropic"), false),
        ))

        assertEquals(1, model.first())
        assertEquals(3, model.next(1, 1))
        assertEquals(1, model.next(3, -1))
    }

    fun `test item keeps reasoning variants`() {
        val item = ModelPicker.Item("gpt", "GPT", "openai", "OpenAI", variants = listOf("low", "high"))

        assertEquals(listOf("low", "high"), item.variants)
    }

    private fun item(
        id: String,
        display: String,
        provider: String,
        name: String,
        index: Double? = null,
    ) = ModelPicker.Item(id, display, provider, name, index)
}
