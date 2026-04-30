package ai.kilocode.client.session.views

import ai.kilocode.client.plugin.KiloBundle
import ai.kilocode.client.session.model.Content
import ai.kilocode.client.session.model.Tool
import ai.kilocode.client.session.model.ToolExecState
import ai.kilocode.client.session.ui.SessionStyle
import ai.kilocode.client.ui.UiStyle
import com.intellij.icons.AllIcons
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import java.awt.BorderLayout
import java.awt.Cursor
import java.awt.datatransfer.StringSelection
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.io.File
import javax.swing.JButton
import javax.swing.JPanel
import javax.swing.ScrollPaneConstants

/** Renders tool calls with VS Code-inspired rows/cards for read and bash. */
class ToolView(tool: Tool) : PartView() {

    override val contentId: String = tool.id

    private var item = tool
    private var open = false
    private var mode = tool.name

    private val root = JPanel(BorderLayout()).apply {
        isOpaque = true
        background = UiStyle.Colors.surface()
        border = UiStyle.Borders.card()
    }
    private val header = JPanel(UiStyle.Gap.layout()).apply {
        isOpaque = true
        background = UiStyle.Colors.surface()
        border = UiStyle.Insets.header()
    }
    private val glyph = JBLabel()
    private val title = JBLabel()
    private val sub = JBLabel().apply {
        foreground = UiStyle.Colors.weak()
    }
    private val state = JBLabel().apply {
        foreground = UiStyle.Colors.weak()
    }
    private val arrow = JBLabel()
    private val copy = JButton(AllIcons.Actions.Copy).apply {
        UiStyle.Buttons.icon(this)
        toolTipText = KiloBundle.message("session.part.tool.copy")
        addActionListener { copyShell() }
    }
    private val text = JBTextArea().apply {
        isEditable = false
        lineWrap = false
        wrapStyleWord = false
        foreground = UiStyle.Colors.fg()
        background = UiStyle.Colors.surface()
        border = UiStyle.Insets.body()
    }
    private val mini = JBTextArea().apply {
        isEditable = false
        lineWrap = false
        wrapStyleWord = false
        foreground = UiStyle.Colors.weak()
        background = UiStyle.Colors.surface()
        border = UiStyle.Insets.body()
    }
    private val scroll = JBScrollPane(text).apply {
        border = UiStyle.Borders.cardTop()
        isOpaque = true
        background = UiStyle.Colors.surface()
        viewport.background = UiStyle.Colors.surface()
        horizontalScrollBarPolicy = ScrollPaneConstants.HORIZONTAL_SCROLLBAR_AS_NEEDED
        verticalScrollBarPolicy = ScrollPaneConstants.VERTICAL_SCROLLBAR_AS_NEEDED
    }
    private val preview = JPanel(BorderLayout()).apply {
        isOpaque = true
        background = UiStyle.Colors.surface()
        border = UiStyle.Borders.cardTop()
        add(mini, BorderLayout.CENTER)
    }

    private val click = object : MouseAdapter() {
        override fun mouseClicked(e: MouseEvent) {
            if (mode != "bash") return
            if (!canExpand(item)) return
            open = !open
            render()
        }
    }

    init {
        layout = BorderLayout()
        isOpaque = false
        header.addMouseListener(click)
        glyph.addMouseListener(click)
        title.addMouseListener(click)
        sub.addMouseListener(click)
        arrow.addMouseListener(click)
        applyStyle(SessionStyle.current())
        add(root, BorderLayout.CENTER)
        render()
    }

    override fun update(content: Content) {
        if (content !is Tool) return
        val was = mode
        item = content
        mode = content.name
        if (was != mode) open = false
        render()
    }

    fun labelText(): String = listOf(title.text, sub.text, state.text).filter { it.isNotBlank() }.joinToString(" ")

    fun commandText(): String = command(item)

    fun outputText(): String = output(item)

    fun bodyText(): String = shellBody(item)

    fun previewText(): String = preview(shellBody(item))

    fun copyText(): String {
        val cmd = command(item)
        val out = output(item)
        if (cmd.isBlank()) return out
        if (out.isBlank()) return cmd
        return "$cmd\n\n$out"
    }

    fun isExpanded(): Boolean = open

    fun hasToggle(): Boolean = arrow.isVisible

    internal fun bodyFont() = text.font

    internal fun previewFont() = mini.font

    internal fun titleFont() = title.font

    internal fun subtitleFont() = sub.font

    internal fun stateFont() = state.font

    override fun applyStyle(style: SessionStyle) {
        title.font = style.boldEditorFont
        sub.font = style.smallEditorFont
        state.font = style.smallEditorFont
        text.font = style.transcriptFont
        mini.font = style.transcriptFont
        revalidate()
        repaint()
    }

    fun toggle() {
        if (mode != "bash") return
        if (!canExpand(item)) return
        open = !open
        render()
    }

    private fun render() {
        root.removeAll()
        header.removeAll()
        val expand = mode == "bash" && canExpand(item)
        if (!expand) open = false
        header.cursor = if (expand) Cursor.getPredefinedCursor(Cursor.HAND_CURSOR) else Cursor.getDefaultCursor()
        glyph.icon = icon(item)
        glyph.foreground = color(item)
        title.foreground = if (item.state == ToolExecState.ERROR) UiStyle.Colors.error() else UiStyle.Colors.fg()
        state.text = stateText(item)
        state.foreground = color(item)

        when (mode) {
            "read" -> renderRead()
            "bash" -> renderShell()
            else -> renderGeneric()
        }

        root.add(header, BorderLayout.NORTH)
        if (mode == "bash" && open && expand) root.add(scroll, BorderLayout.CENTER)
        if (mode == "bash" && (!open || !expand) && shellBody(item).isNotBlank()) root.add(preview, BorderLayout.CENTER)
        revalidate()
        repaint()
    }

    private fun renderRead() {
        title.text = KiloBundle.message("session.part.tool.read")
        sub.text = readPath(item)
        val main = JPanel(UiStyle.Gap.layout()).apply {
            isOpaque = false
            add(title, BorderLayout.WEST)
            add(sub, BorderLayout.CENTER)
        }
        header.add(glyph, BorderLayout.WEST)
        header.add(main, BorderLayout.CENTER)
        header.add(state, BorderLayout.EAST)
    }

    private fun renderShell() {
        title.text = KiloBundle.message("session.part.tool.shell")
        sub.text = shellTitle(item)
        val expand = canExpand(item)
        arrow.isVisible = expand
        arrow.icon = if (open) AllIcons.General.ArrowDown else AllIcons.General.ArrowRight
        val cursor = if (expand) Cursor.getPredefinedCursor(Cursor.HAND_CURSOR) else Cursor.getDefaultCursor()
        glyph.cursor = cursor
        title.cursor = cursor
        sub.cursor = cursor
        arrow.cursor = cursor
        val main = JPanel(UiStyle.Gap.layout()).apply {
            isOpaque = false
            add(title, BorderLayout.WEST)
            add(sub, BorderLayout.CENTER)
        }
        val right = JPanel(UiStyle.Gap.layout(UiStyle.Space.SM)).apply {
            isOpaque = false
            val controls = JPanel(UiStyle.Gap.layout(UiStyle.Space.SM)).apply {
                isOpaque = false
                if (copyText().isNotBlank()) add(copy, BorderLayout.WEST)
                add(arrow, BorderLayout.EAST)
            }
            add(controls, BorderLayout.EAST)
        }
        text.text = shellBody(item)
        mini.text = preview(shellBody(item))
        text.foreground = if (item.state == ToolExecState.ERROR) UiStyle.Colors.error() else UiStyle.Colors.fg()
        header.add(glyph, BorderLayout.WEST)
        header.add(main, BorderLayout.CENTER)
        header.add(right, BorderLayout.EAST)
    }

    private fun renderGeneric() {
        title.text = item.title?.takeIf { it.isNotBlank() } ?: item.name
        sub.text = item.name.takeIf { title.text != it } ?: ""
        val main = JPanel(UiStyle.Gap.layout()).apply {
            isOpaque = false
            add(title, BorderLayout.WEST)
            add(sub, BorderLayout.CENTER)
        }
        header.add(glyph, BorderLayout.WEST)
        header.add(main, BorderLayout.CENTER)
        header.add(state, BorderLayout.EAST)
    }

    private fun copyShell() {
        val value = copyText()
        if (value.isBlank()) return
        CopyPasteManager.getInstance().setContents(StringSelection(value))
    }

    override fun dumpLabel() = "ToolView#$contentId(${labelText()})"
}

private fun icon(tool: Tool) = when (tool.name) {
    "read" -> AllIcons.Actions.Preview
    "bash" -> AllIcons.Debugger.Console
    else -> when (tool.state) {
        ToolExecState.PENDING -> AllIcons.Process.Step_1
        ToolExecState.RUNNING -> AllIcons.Process.Step_2
        ToolExecState.COMPLETED -> AllIcons.Actions.Checked
        ToolExecState.ERROR -> AllIcons.General.Error
    }
}

private fun color(tool: Tool) = when (tool.state) {
    ToolExecState.PENDING -> UiStyle.Colors.weak()
    ToolExecState.RUNNING -> UiStyle.Colors.running()
    ToolExecState.COMPLETED -> UiStyle.Colors.weak()
    ToolExecState.ERROR -> UiStyle.Colors.error()
}

private fun stateText(tool: Tool) = when (tool.state) {
    ToolExecState.PENDING -> KiloBundle.message("session.part.tool.pending")
    ToolExecState.RUNNING -> KiloBundle.message("session.part.tool.running")
    ToolExecState.COMPLETED -> ""
    ToolExecState.ERROR -> KiloBundle.message("session.part.tool.error")
}

private fun readPath(tool: Tool): String {
    val path = tool.input["filePath"] ?: tool.input["path"] ?: tool.title ?: return tool.name
    return File(path).name.ifBlank { path }
}

private fun shellTitle(tool: Tool): String =
    tool.input["description"]?.takeIf { it.isNotBlank() }
        ?: tool.metadata["description"]?.takeIf { it.isNotBlank() }
        ?: tool.title?.takeIf { it.isNotBlank() }
        ?: command(tool).lineSequence().firstOrNull { it.isNotBlank() }
        ?: ""

private fun command(tool: Tool): String =
    tool.input["command"]?.takeIf { it.isNotBlank() }
        ?: tool.metadata["command"]?.takeIf { it.isNotBlank() }
        ?: ""

private fun output(tool: Tool): String =
    tool.output?.takeIf { it.isNotBlank() }
        ?: tool.metadata["output"]?.takeIf { it.isNotBlank() }
        ?: ""

private fun shellBody(tool: Tool): String {
    val cmd = command(tool)
    val out = output(tool)
    val err = tool.error?.takeIf { it.isNotBlank() }
    return buildString {
        if (cmd.isNotBlank()) append("$ ").append(cmd)
        if (out.isNotBlank()) {
            if (isNotEmpty()) append("\n\n")
            append(out)
        }
        if (err != null) {
            if (isNotEmpty()) append("\n\n")
            append(err)
        }
    }
}

private const val PREVIEW_LINES = 3

private fun canExpand(tool: Tool): Boolean = lines(shellBody(tool)) > PREVIEW_LINES

private fun preview(text: String): String = text.lineSequence().take(PREVIEW_LINES).joinToString("\n")

private fun lines(text: String): Int = if (text.isBlank()) 0 else text.lineSequence().count()
