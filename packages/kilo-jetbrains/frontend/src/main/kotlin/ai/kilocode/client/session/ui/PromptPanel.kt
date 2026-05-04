package ai.kilocode.client.session.ui

import ai.kilocode.client.plugin.KiloBundle
import ai.kilocode.client.session.ui.mode.ModePicker
import ai.kilocode.client.session.ui.model.ModelPicker
import ai.kilocode.client.ui.UiStyle
import ai.kilocode.log.ChatLogSummary
import ai.kilocode.log.KiloLog
import com.intellij.icons.AllIcons
import com.intellij.openapi.fileTypes.PlainTextFileType
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.IconLoader
import com.intellij.ui.EditorTextField
import com.intellij.util.ui.JBValue
import com.intellij.util.ui.JBDimension
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import com.intellij.util.ui.components.BorderLayoutPanel
import java.awt.BorderLayout
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.RenderingHints
import java.awt.event.FocusAdapter
import java.awt.event.FocusEvent
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.Icon
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.ScrollPaneConstants

/**
 * Prompt input panel with borderless IntelliJ editor text field and
 * mode/model controls grouped inside one rounded editor-background shell.
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
        private const val ARC = 6
        private const val FOCUS = 2
    }

    val mode = ModePicker()
    val model = ModelPicker()
    val reasoning = ReasoningPicker()
    var onReset: () -> Unit = {}
    private var style = SessionStyle.current()
    private val shell = PromptShell()

    private val editor = EditorTextField(project, PlainTextFileType.INSTANCE).apply {
        border = JBUI.Borders.empty()
        setFontInheritedFromLAF(false)
        setPlaceholder(KiloBundle.message("prompt.placeholder"))
        setShowPlaceholderWhenFocused(true)
        setOneLineMode(false)
        addSettingsProvider { ed ->
            style.applyToEditor(ed)
            ed.setBorder(JBUI.Borders.empty())
            ed.scrollPane.border = JBUI.Borders.empty()
            ed.scrollPane.viewportBorder = JBUI.Borders.empty()
            ed.settings.isUseSoftWraps = true
            ed.settings.isAdditionalPageAtBottom = false
            ed.scrollPane.horizontalScrollBarPolicy =
                ScrollPaneConstants.HORIZONTAL_SCROLLBAR_NEVER
            ed.contentComponent.addFocusListener(object : FocusAdapter() {
                override fun focusGained(e: FocusEvent) {
                    shell.repaint()
                }

                override fun focusLost(e: FocusEvent) {
                    shell.repaint()
                }
            })
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

    private val reset = UiStyle.Buttons.HoverIcon().apply {
        icon = AllIcons.Actions.Cancel
        toolTipText = KiloBundle.message("model.picker.reset")
        accessibleContext.accessibleName = KiloBundle.message("model.picker.reset")
        isVisible = false
        addActionListener { onReset() }
    }

    @Volatile
    private var busy = false

    init {
        border = JBUI.Borders.compound(
            JBUI.Borders.customLineTop(JBUI.CurrentTheme.ToolWindow.borderColor()),
            UiStyle.Insets.prompt(),
        )

        applyStyle(style)
        shell.add(editor, BorderLayout.CENTER)

        val bar = BorderLayoutPanel().apply {
            layout = BoxLayout(this, BoxLayout.X_AXIS)
            isOpaque = false
            border = JBUI.Borders.emptyTop(UiStyle.Space.SM)
        }
        bar.add(mode)
        bar.add(Box.createHorizontalStrut(UiStyle.Gap.xs()))
        bar.add(model)
        bar.add(Box.createHorizontalStrut(UiStyle.Gap.xs()))
        bar.add(reasoning)
        bar.add(Box.createHorizontalStrut(UiStyle.Gap.xs()))
        bar.add(reset)
        bar.add(Box.createHorizontalGlue())
        bar.add(button)
        shell.add(bar, BorderLayout.SOUTH)
        add(shell, BorderLayout.CENTER)
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

    fun setResetVisible(value: Boolean) {
        reset.isVisible = value
        revalidate()
        repaint()
    }

    fun text(): String = editor.text.trim()

    internal fun inputFont() = editor.font

    internal fun resetVisibleForTest() = reset.isVisible

    internal fun resetForTest(): JComponent = reset

    internal fun shellForTest(): JComponent = shell

    internal val defaultFocusedComponent: JComponent get() = editor

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

    private inner class PromptShell : BorderLayoutPanel() {
        private val arc = JBValue.UIInteger("Button.arc", ARC)
        private val focus = JBValue.UIInteger("Component.focusWidth", FOCUS)

        init {
            isOpaque = false
            border = JBUI.Borders.empty(UiStyle.Space.MD, UiStyle.Space.LG)
        }

        override fun updateUI() {
            super.updateUI()
            border = JBUI.Borders.empty(UiStyle.Space.MD, UiStyle.Space.LG)
        }

        override fun paintComponent(g: Graphics) {
            val g2 = g.create() as Graphics2D
            try {
                g2.setRenderingHint(
                    RenderingHints.KEY_ANTIALIASING,
                    RenderingHints.VALUE_ANTIALIAS_ON,
                )
                g2.color = UiStyle.Colors.panel()
                val size = arc.get()
                g2.fillRoundRect(0, 0, width, height, size, size)
                val active = UIUtil.isFocusAncestor(editor)
                g2.color = if (active) {
                    JBUI.CurrentTheme.Focus.focusColor()
                } else {
                    UiStyle.Colors.line()
                }
                val bw = if (active) focus.get() else JBUI.scale(1)
                for (idx in 0 until bw) {
                    val inset = idx
                    val w = width - inset * 2 - 1
                    val h = height - inset * 2 - 1
                    if (w > 0 && h > 0) {
                        g2.drawRoundRect(inset, inset, w, h, size, size)
                    }
                }
            } finally {
                g2.dispose()
            }
            super.paintComponent(g)
        }
    }
}
