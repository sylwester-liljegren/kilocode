package ai.kilocode.client.session.ui

import ai.kilocode.rpc.dto.ModelSelectionDto
import com.intellij.icons.AllIcons
import com.intellij.ui.CollectionListModel
import com.intellij.ui.components.JBList
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.util.ui.EmptyIcon

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

        assertEquals("Favorites", modelPickerSectionTitle(rows, 0))
        assertEquals("openai/gpt-4o", rows[0].item.key)
        assertEquals("Recommended", modelPickerSectionTitle(rows, 1))
        assertEquals("kilo/auto", rows[1].item.key)
        assertEquals("anthropic/claude", rows[2].item.key)
    }

    fun `test favorites are hidden while filtering`() {
        val rows = modelPickerRows(listOf(
            item("gpt-4o", "GPT 4o", "openai", "OpenAI"),
            item("claude", "Claude Sonnet", "anthropic", "Anthropic"),
        ), listOf(ModelSelectionDto("openai", "gpt-4o")), "gpt")


        assertFalse(rows.indices.any { modelPickerSectionTitle(rows, it) == "Favorites" })
        assertEquals("openai/gpt-4o", rows.single().item.key)
    }

    fun `test kilo provider group is first and other providers keep source order`() {
        val rows = modelPickerRows(listOf(
            item("gpt", "GPT", "openai", "OpenAI"),
            item("auto", "Auto", "kilo", "Kilo"),
            item("claude", "Claude", "anthropic", "Anthropic"),
        ), emptyList(), "")

        assertEquals(listOf("Kilo", "OpenAI", "Anthropic"), rows.indices.mapNotNull { modelPickerSectionTitle(rows, it) })
    }

    fun `test index prefers normal row over favorite duplicate`() {
        val rows = listOf(
            ModelPickerRow(item("a", "A", "openai", "OpenAI"), "Favorites", true),
            ModelPickerRow(item("a", "A", "openai", "OpenAI"), "OpenAI", false),
        )

        assertEquals(1, modelPickerIndex(rows, "openai/a"))
    }

    fun `test item keeps reasoning variants`() {
        val item = ModelPicker.Item("gpt", "GPT", "openai", "OpenAI", variants = listOf("low", "high"))

        assertEquals(listOf("low", "high"), item.variants)
    }

    fun `test display parts split provider prefix`() {
        val parts = ModelText.parts(item("claude-opus", "Anthropic Claude Opus 4.7", "anthropic", "Anthropic"))

        assertEquals("Anthropic", parts.provider)
        assertEquals("Claude Opus 4.7", parts.model)
    }

    fun `test display parts split vscode colon form`() {
        val parts = ModelText.parts(item("claude-opus", "Anthropic: Claude Opus 4.7", "anthropic", "Anthropic"))

        assertEquals("Anthropic", parts.provider)
        assertEquals("Claude Opus 4.7", parts.model)
    }

    fun `test display parts trim colon segments`() {
        val parts = ModelText.parts(item("laguna", " Poolside : Laguna M.1 ", "poolside", "Poolside"))

        assertEquals("Poolside", parts.provider)
        assertEquals("Laguna M.1", parts.model)
    }

    fun `test display parts keep plain model name`() {
        val parts = ModelText.parts(item("claude-sonnet", "Claude Sonnet 4.6", "anthropic", "Anthropic"))

        assertNull(parts.provider)
        assertEquals("Claude Sonnet 4.6", parts.model)
    }

    fun `test display parts sanitize free suffix`() {
        val parts = ModelText.parts(item("auto", "Auto Free (free)", "kilo", "Kilo"))

        assertNull(parts.provider)
        assertEquals("Auto Free", parts.model)
    }

    fun `test renderer shows empty favorite star only for selected row`() {
        val row = ModelPickerRow(item("auto", "Auto", "kilo", "Kilo"), "Kilo", false)
        val model = CollectionListModel(listOf(row))
        val renderer = ModelPickerRenderer(model, { null }, { emptySet() })
        val list = JBList(model)

        renderer.getListCellRendererComponent(list, row, 0, false, false)
        assertSame(EmptyIcon.ICON_16, renderer.starIcon())

        renderer.getListCellRendererComponent(list, row, 0, true, false)
        assertSame(AllIcons.Nodes.NotFavoriteOnHover, renderer.starIcon())
    }

    fun `test renderer keeps favorite star visible`() {
        val row = ModelPickerRow(item("auto", "Auto", "kilo", "Kilo"), "Kilo", false)
        val model = CollectionListModel(listOf(row))
        val renderer = ModelPickerRenderer(model, { null }, { setOf("kilo/auto") })
        val list = JBList(model)

        renderer.getListCellRendererComponent(list, row, 0, false, false)

        assertSame(AllIcons.Nodes.Favorite, renderer.starIcon())
    }

    fun `test renderer shows free badge for free model`() {
        val row = ModelPickerRow(ModelPicker.Item("auto", "Auto", "kilo", "Kilo", free = true), "Kilo", false)
        val model = CollectionListModel(listOf(row))
        val renderer = ModelPickerRenderer(model, { null }, { emptySet() })
        val list = JBList(model)

        renderer.getListCellRendererComponent(list, row, 0, false, false)

        assertTrue(renderer.badgeVisible())
    }

    private fun item(
        id: String,
        display: String,
        provider: String,
        name: String,
        index: Double? = null,
    ) = ModelPicker.Item(id, display, provider, name, index)
}
