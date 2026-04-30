package ai.kilocode.client.session.ui

import ai.kilocode.client.plugin.KiloBundle
import ai.kilocode.client.ui.UiStyle
import ai.kilocode.log.ChatLogSummary
import ai.kilocode.log.KiloLog
import com.intellij.openapi.fileTypes.PlainTextFileType
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.IconLoader
import com.intellij.ui.EditorTextField
import com.intellij.util.ui.JBDimension
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.components.BorderLayoutPanel
import java.awt.BorderLayout
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.Icon
import javax.swing.JButton
import javax.swing.ScrollPaneConstants

/**
 * Prompt input panel with an IntelliJ editor text field and a bottom
 * bar containing mode/model pickers and a send/stop button, all on
 * the same row stretched to the same height.
 *
 * Layout:
 * ```
 * ┌──────────────────────────────────┐
 * │  EditorTextField (3 lines)       │
 * ├──────────────────────────────────┤
 * │ [Default ▾] [sonnet ▾]     [▶]  │
 * └──────────────────────────────────┘
 * ```
 */
class PromptPanel(
    private val project: Project,
    private val onSend: (String) -> Unit,
    private val onAbort: () -> Unit,
) : BorderLayoutPanel(), SessionStyleTarget {

    companion object {
        private val LOG = KiloLog.create(PromptPanel::class.java)
        private val SEND_ICON: Icon = IconLoader.getIcon("/icons/send.svg", PromptPanel::class.java)
        private val STOP_ICON: Icon = IconLoader.getIcon("/icons/stop.svg", PromptPanel::class.java)
    }

    val mode = LabelPicker()
    val model = LabelPicker()
    private var style = SessionStyle.current()

    private val editor = EditorTextField(project, PlainTextFileType.INSTANCE).apply {
        setFontInheritedFromLAF(false)
        setPlaceholder(KiloBundle.message("prompt.placeholder"))
        setShowPlaceholderWhenFocused(true)
        setOneLineMode(false)
        addSettingsProvider { ed ->
            style.applyToEditor(ed)
            ed.settings.isUseSoftWraps = true
            ed.settings.isAdditionalPageAtBottom = false
            ed.scrollPane.horizontalScrollBarPolicy =
                ScrollPaneConstants.HORIZONTAL_SCROLLBAR_NEVER
            ed.contentComponent.addKeyListener(object : KeyAdapter() {
                override fun keyPressed(e: KeyEvent) {
                    if (e.keyCode == KeyEvent.VK_ENTER && !e.isShiftDown) {
                        e.consume()
                        submit("enter")
                    }
                }
            })
        }
    }

    private val button = JButton(SEND_ICON).apply {
        UiStyle.Buttons.icon(this)
        isFocusPainted = false
        toolTipText = KiloBundle.message("prompt.button.send")
        isEnabled = false
        maximumSize = JBDimension(JBUI.scale(UiStyle.Size.BUTTON_WIDTH), Short.MAX_VALUE.toInt())
        preferredSize = JBUI.size(UiStyle.Size.BUTTON, UiStyle.Size.BUTTON)
        addActionListener {
            if (busy) onAbort()
            else submit("button")
        }
    }

    @Volatile
    private var busy = false

    init {
        border = UiStyle.Insets.prompt()

        applyStyle(style)
        add(editor, BorderLayout.CENTER)

        val bar = BorderLayoutPanel().apply {
            layout = BoxLayout(this, BoxLayout.X_AXIS)
            isOpaque = false
            border = JBUI.Borders.emptyTop(UiStyle.Space.SM)
        }
        bar.add(mode)
        bar.add(model)
        bar.add(Box.createHorizontalGlue())
        bar.add(button)
        add(bar, BorderLayout.SOUTH)
    }

    fun setReady(value: Boolean) {
        button.isEnabled = value
    }

    fun setBusy(value: Boolean) {
        busy = value
        button.icon = if (value) STOP_ICON else SEND_ICON
        button.toolTipText = if (value) {
            KiloBundle.message("prompt.button.stop")
        } else {
            KiloBundle.message("prompt.button.send")
        }
    }

    fun text(): String = editor.text.trim()

    internal fun inputFont() = editor.font

    override fun applyStyle(style: SessionStyle) {
        this.style = style
        editor.font = style.transcriptFont
        editor.getEditor(false)?.let(style::applyToEditor)
        val height = style.transcriptFont.size * UiStyle.Size.LINES + JBUI.scale(
            UiStyle.Size.CHROME)
        editor.preferredSize = JBDimension(0, height)
        editor.minimumSize = JBDimension(0, height)
        revalidate()
        repaint()
    }

    fun clear() {
        editor.text = ""
    }

    fun focus() {
        editor.requestFocusInWindow()
    }

    private fun submit(src: String) {
        if (busy) return
        val txt = text()
        LOG.debug { "${ChatLogSummary.prompt(txt)} src=$src busy=$busy" }
        if (txt.isNotEmpty()) {
            onSend(txt)
        }
    }
}
