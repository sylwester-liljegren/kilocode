package ai.kilocode.client.session.ui

import com.intellij.testFramework.fixtures.BasePlatformTestCase

@Suppress("UnstableApiUsage")
class PromptPanelTest : BasePlatformTestCase() {

    fun `test prompt input uses editor font settings`() {
        val style = SessionStyle.current()
        val panel = PromptPanel(project, {}, {})
        val font = panel.inputFont()

        assertEquals(style.editorFamily, font.name)
        assertEquals(style.editorSize, font.size)
    }

    fun `test applyStyle updates prompt input and height`() {
        val panel = PromptPanel(project, {}, {})
        val style = SessionStyle.create(family = "Courier New", size = 26)

        panel.applyStyle(style)

        assertEquals("Courier New", panel.inputFont().name)
        assertEquals(26, panel.inputFont().size)
        assertTrue(panel.preferredSize.height >= 26)
    }

    fun `test reasoning picker hides when variants are empty`() {
        val panel = PromptPanel(project, {}, {})

        panel.reasoning.setItems(emptyList())

        assertFalse(panel.reasoning.isVisible)
    }

    fun `test reasoning picker shows selected variant`() {
        val panel = PromptPanel(project, {}, {})

        panel.reasoning.setItems(listOf(LabelPicker.Item("low", "Low"), LabelPicker.Item("high", "High")), "high")

        assertTrue(panel.reasoning.isVisible)
        assertEquals("high", panel.reasoning.selectedForTest()?.id)
    }

    fun `test reset visibility can be toggled`() {
        val panel = PromptPanel(project, {}, {})

        panel.setResetVisible(true)

        assertTrue(panel.resetVisibleForTest())
    }
}
