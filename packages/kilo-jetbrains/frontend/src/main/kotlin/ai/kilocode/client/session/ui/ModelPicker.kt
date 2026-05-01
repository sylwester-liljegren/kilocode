package ai.kilocode.client.session.ui

import ai.kilocode.client.plugin.KiloBundle
import ai.kilocode.client.ui.UiStyle
import ai.kilocode.rpc.dto.ModelSelectionDto
import com.intellij.icons.AllIcons
import com.intellij.openapi.ui.popup.JBPopup
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.ui.popup.PopupShowOptions
import com.intellij.ui.DocumentAdapter
import com.intellij.ui.ListUtil
import com.intellij.ui.ScrollPaneFactory
import com.intellij.ui.ScrollingUtil
import com.intellij.ui.SearchTextField
import com.intellij.ui.SimpleColoredComponent
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBList
import com.intellij.util.ui.EmptyIcon
import com.intellij.util.ui.JBDimension
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import com.intellij.util.ui.components.BorderLayoutPanel
import java.awt.BorderLayout
import java.awt.Cursor
import java.awt.FlowLayout
import java.awt.Point
import java.awt.Rectangle
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.AbstractListModel
import javax.swing.Icon
import javax.swing.JList
import javax.swing.JPanel
import javax.swing.ListCellRenderer
import javax.swing.ListSelectionModel
import javax.swing.ScrollPaneConstants
import javax.swing.SwingConstants
import javax.swing.SwingUtilities
import javax.swing.event.DocumentEvent

class ModelPicker : JBLabel() {

    data class Item(
        val id: String,
        val display: String,
        val provider: String,
        val providerName: String,
        val recommendedIndex: Double? = null,
        val free: Boolean = false,
        val variants: List<String> = emptyList(),
    ) {
        val key: String get() = "$provider/$id"

        override fun toString(): String = listOf(display, id, providerName).joinToString(" ")
    }

    var onSelect: (Item) -> Unit = {}
    var favorites: () -> List<ModelSelectionDto> = { emptyList() }
    var onFavoriteToggle: (Item) -> Unit = {}

    private var items: List<Item> = emptyList()
    private var selected: Item? = null

    init {
        border = UiStyle.Borders.picker()
        isEnabled = false
        text = " "

        addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (!isEnabled || items.isEmpty()) return
                showPopup()
            }
        })
    }

    fun setItems(values: List<Item>, default: String? = null) {
        items = values
        val key = default ?: selected?.key
        selected = key?.let { target -> values.firstOrNull { it.key == target || it.id == target } }
            ?: values.firstOrNull()
        refresh()
    }

    fun select(key: String) {
        selected = items.firstOrNull { it.key == key || it.id == key }
        refresh()
    }

    private fun refresh() {
        if (items.isEmpty()) {
            isEnabled = false
            text = " "
            cursor = Cursor.getDefaultCursor()
            return
        }
        val display = selected?.display ?: items.firstOrNull()?.display ?: ""
        text = "${ModelText.sanitize(display)} ▴"
        isEnabled = true
        cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
    }

    private fun showPopup() {
        val model = ModelPickerListModel()
        var mouse = -1
        val renderer = ModelPickerRenderer({ selected?.key }, { mouse }) { favoriteKeys().contains(it.key) }
        val list = JBList(model).apply {
            selectionMode = ListSelectionModel.SINGLE_SELECTION
            visibleRowCount = ModelPickerRenderer.MAX_ROWS
            cellRenderer = renderer
            emptyText.text = KiloBundle.message("model.picker.no.matches")
            fixedCellWidth = JBUI.scale(UiStyle.Size.WIDTH)
        }
        val search = SearchTextField(false).apply {
            textEditor.emptyText.text = KiloBundle.message("model.picker.search")
        }

        lateinit var popup: JBPopup

        fun activeKey(): String? = (list.selectedValue as? ModelPickerRow.Entry)?.item?.key

        fun choose(idx: Int) {
            list.selectedIndex = idx
            list.ensureIndexIsVisible(idx)
        }

        fun sync(prefer: String? = activeKey()) {
            model.setRows(modelPickerRows(items, favorites(), search.text))
            val idx = model.index(prefer).takeIf { it >= 0 }
                ?: model.index(selected?.key).takeIf { it >= 0 }
                ?: model.first()
            if (idx >= 0) choose(idx)
            else list.clearSelection()
        }

        fun activate(item: Item) {
            selected = item
            refresh()
            onSelect(item)
            popup.closeOk(null)
        }

        fun move(step: Int) {
            val idx = model.next(list.selectedIndex, step)
            if (idx >= 0) choose(idx)
        }

        search.addDocumentListener(object : DocumentAdapter() {
            override fun textChanged(e: DocumentEvent) {
                sync()
            }
        })
        val keys = object : KeyAdapter() {
            override fun keyPressed(e: KeyEvent) {
                when (e.keyCode) {
                    KeyEvent.VK_ESCAPE -> {
                        e.consume()
                        popup.cancel()
                    }
                    KeyEvent.VK_DOWN -> {
                        e.consume()
                        move(1)
                    }
                    KeyEvent.VK_UP -> {
                        e.consume()
                        move(-1)
                    }
                    KeyEvent.VK_ENTER -> {
                        e.consume()
                        (list.selectedValue as? ModelPickerRow.Entry)?.item?.let(::activate)
                    }
                }
            }
        }
        search.addKeyboardListener(keys)
        list.addKeyListener(keys)
        list.addMouseListener(object : MouseAdapter() {
            override fun mouseExited(e: MouseEvent) {
                mouse = -1
                list.repaint()
            }

            override fun mouseReleased(e: MouseEvent) {
                if (!SwingUtilities.isLeftMouseButton(e)) return
                val row = list.locationToIndex(e.point)
                val bounds = row.takeIf { it >= 0 }?.let { list.getCellBounds(it, it) } ?: return
                if (!bounds.contains(e.point)) return
                val value = model.getElementAt(row) as? ModelPickerRow.Entry ?: return
                if (renderer.favoriteHit(list, value, row, e.point, bounds)) {
                    onFavoriteToggle(value.item)
                    sync(value.item.key)
                    return
                }
                activate(value.item)
            }
        })
        list.addMouseMotionListener(object : MouseAdapter() {
            override fun mouseMoved(e: MouseEvent) {
                val idx = list.locationToIndex(e.point)
                val bounds = idx.takeIf { it >= 0 }?.let { list.getCellBounds(it, it) }
                val next = idx.takeIf { bounds?.contains(e.point) == true } ?: -1
                if (mouse == next) return
                mouse = next
                list.repaint()
            }
        })
        ListUtil.installAutoSelectOnMouseMove(list)
        ScrollingUtil.installActions(list)

        val scroll = ScrollPaneFactory.createScrollPane(list).apply {
            horizontalScrollBarPolicy = ScrollPaneConstants.HORIZONTAL_SCROLLBAR_NEVER
            verticalScrollBarPolicy = ScrollPaneConstants.VERTICAL_SCROLLBAR_AS_NEEDED
            preferredSize = JBDimension(
                JBUI.scale(UiStyle.Size.WIDTH) + UIUtil.getScrollBarWidth(),
                JBUI.scale(300),
            )
        }
        val content = BorderLayoutPanel().apply {
            border = JBUI.Borders.empty(UiStyle.Space.SM)
            add(search, BorderLayout.NORTH)
            add(scroll, BorderLayout.CENTER)
            preferredSize = scroll.preferredSize
        }

        sync(selected?.key)
        popup = JBPopupFactory.getInstance()
            .createComponentPopupBuilder(content, search)
            .setRequestFocus(true)
            .setCancelOnClickOutside(true)
            .setCancelKeyEnabled(true)
            .setResizable(false)
            .setMovable(false)
            .createPopup()

        popup.show(PopupShowOptions.aboveComponent(this))
        SwingUtilities.invokeLater {
            search.textEditor.requestFocusInWindow()
            search.selectText()
            list.selectedIndex.takeIf { it >= 0 }?.let(list::ensureIndexIsVisible)
        }
    }

    private fun favoriteKeys(): List<String> = favorites().map { "${it.providerID}/${it.modelID}" }
}

internal sealed class ModelPickerRow {
    data class Header(val label: String) : ModelPickerRow()
    data class Entry(val item: ModelPicker.Item, val favorite: Boolean) : ModelPickerRow()
}

internal class ModelPickerListModel : AbstractListModel<ModelPickerRow>() {
    private var rows: List<ModelPickerRow> = emptyList()

    override fun getSize(): Int = rows.size

    override fun getElementAt(index: Int): ModelPickerRow = rows[index]

    fun setRows(value: List<ModelPickerRow>) {
        val old = rows.size
        rows = value
        if (old > 0) fireIntervalRemoved(this, 0, old - 1)
        if (rows.isNotEmpty()) fireIntervalAdded(this, 0, rows.size - 1)
    }

    fun index(key: String?): Int {
        if (key == null) return -1
        return rows.indexOfFirst { it is ModelPickerRow.Entry && it.item.key == key && !it.favorite }
            .takeIf { it >= 0 }
            ?: rows.indexOfFirst { it is ModelPickerRow.Entry && it.item.key == key }
    }

    fun first(): Int = rows.indexOfFirst { it is ModelPickerRow.Entry }

    fun next(index: Int, step: Int): Int {
        val cur = index.takeIf { it >= 0 } ?: first()
        var idx = cur + step
        while (idx in rows.indices) {
            if (rows[idx] is ModelPickerRow.Entry) return idx
            idx += step
        }
        return cur.takeIf { it in rows.indices && rows[it] is ModelPickerRow.Entry } ?: first()
    }
}

internal class ModelPickerRenderer(
    private val active: () -> String?,
    private val mouse: () -> Int,
    private val favorite: (ModelPicker.Item) -> Boolean,
) : JPanel(BorderLayout()), ListCellRenderer<ModelPickerRow> {
    companion object {
        const val MAX_ROWS = 10
        val checked: Icon = AllIcons.Actions.Checked
        val empty: Icon = EmptyIcon.create(checked)
    }

    private val icon = JBLabel().apply {
        UiStyle.Components.transparent(this)
        horizontalAlignment = SwingConstants.CENTER
        verticalAlignment = SwingConstants.CENTER
    }
    private val title = SimpleColoredComponent().apply {
        UiStyle.Components.transparent(this)
    }
    private val tag = JBLabel(KiloBundle.message("model.picker.free")).apply {
        UiStyle.Components.transparent(this)
    }
    private val provider = JBLabel().apply {
        UiStyle.Components.transparent(this)
    }
    private val star = JBLabel().apply {
        UiStyle.Components.transparent(this)
        horizontalAlignment = SwingConstants.CENTER
        verticalAlignment = SwingConstants.CENTER
    }
    private val head = JPanel(FlowLayout(FlowLayout.LEFT, 0, 0)).apply {
        UiStyle.Components.transparent(this)
        add(title)
        add(tag)
        add(provider)
    }
    private val body = JPanel(BorderLayout()).apply {
        UiStyle.Components.transparent(this)
        add(head, BorderLayout.CENTER)
    }
    private val line = JPanel(BorderLayout()).apply {
        UiStyle.Components.transparent(this)
        add(icon, BorderLayout.WEST)
        add(body, BorderLayout.CENTER)
        add(star, BorderLayout.EAST)
    }
    private val header = JBLabel().apply {
        UiStyle.Components.transparent(this)
    }

    init {
        isOpaque = true
    }

    override fun getListCellRendererComponent(
        list: JList<out ModelPickerRow>,
        value: ModelPickerRow,
        index: Int,
        selected: Boolean,
        focused: Boolean,
    ): java.awt.Component {
        removeAll()
        if (value is ModelPickerRow.Header) return header(list, value)
        value as ModelPickerRow.Entry
        val focus = selected || list.hasFocus() || focused
        val fg = UIUtil.getListForeground(selected, focus)
        val bg = UIUtil.getListBackground(selected, focus)
        background = bg
        border = JBUI.Borders.empty(
            UiStyle.Space.MD,
            UiStyle.Space.LG,
            UiStyle.Space.MD,
            UiStyle.Space.LG + UiStyle.Space.SM,
        )
        icon.icon = if (value.item.key == active()) checked else empty
        title.clear()
        title.append(ModelText.sanitize(value.item.display), SimpleTextAttributes(SimpleTextAttributes.STYLE_BOLD, fg))
        tag.isVisible = value.item.free
        tag.foreground = if (selected) fg else UiStyle.Colors.weak()
        tag.border = JBUI.Borders.emptyLeft(JBUI.CurrentTheme.ActionsList.elementIconGap())
        provider.isVisible = value.favorite
        provider.text = value.item.providerName
        provider.foreground = if (selected) fg else UiStyle.Colors.weak()
        provider.border = JBUI.Borders.emptyLeft(JBUI.CurrentTheme.ActionsList.elementIconGap())
        val marked = favorite(value.item)
        star.icon = when {
            marked -> AllIcons.Nodes.Favorite
            mouse() == index -> AllIcons.Nodes.NotFavoriteOnHover
            else -> null
        }
        star.toolTipText = KiloBundle.message(
            if (favorite(value.item)) "model.picker.favorite.remove" else "model.picker.favorite.add",
        )
        add(line, BorderLayout.CENTER)
        return this
    }

    fun favoriteHit(
        list: JList<out ModelPickerRow>,
        row: ModelPickerRow.Entry,
        index: Int,
        point: Point,
        bounds: Rectangle,
    ): Boolean {
        getListCellRendererComponent(list, row, index, false, false)
        setBounds(0, 0, bounds.width, bounds.height)
        doLayout()
        line.doLayout()
        val local = SwingUtilities.convertRectangle(star.parent, star.bounds, this)
        return Rectangle(bounds.x + local.x, bounds.y + local.y, local.width, local.height).contains(point)
    }

    private fun header(list: JList<out ModelPickerRow>, value: ModelPickerRow.Header): java.awt.Component {
        background = list.background
        border = JBUI.Borders.empty(
            UiStyle.Space.LG,
            UiStyle.Space.LG,
            UiStyle.Space.XS,
            UiStyle.Space.LG + UiStyle.Space.SM,
        )
        header.text = value.label
        header.foreground = UiStyle.Colors.weak()
        add(header, BorderLayout.CENTER)
        return this
    }
}

internal object ModelSearch {
    fun matches(query: String, text: String): Boolean {
        val q = query.lowercase().trim()
        if (q.isEmpty()) return true
        val parts = words(q)
        if (parts.isEmpty()) return true
        return parts.all { acronym(text, it) }
    }

    fun acronym(text: String, query: String): Boolean {
        val words = words(text)
        fun attempt(wi: Int, qi: Int): Boolean {
            if (qi == query.length) return true
            if (wi >= words.size) return false
            val word = words[wi]
            var count = 0
            while (qi + count < query.length && count < word.length && word[count] == query[qi + count]) {
                count++
            }
            if (count > 0 && attempt(wi + 1, qi + count)) return true
            return attempt(wi + 1, qi)
        }
        return attempt(0, 0)
    }

    private fun words(text: String): List<String> {
        val out = mutableListOf<String>()
        val buf = StringBuilder()
        fun flush() {
            if (buf.isEmpty()) return
            out += buf.toString().lowercase()
            buf.clear()
        }
        for (ch in text) {
            if (ch in "[]_.: /\\(){}-") {
                flush()
                continue
            }
            if (ch.isUpperCase() && buf.isNotEmpty()) flush()
            buf.append(ch)
        }
        flush()
        return out
    }
}

internal object ModelText {
    private val small = setOf("kilo-auto/small", "auto-small")

    fun sanitize(text: String): String = text.replace(Regex("[\\s:_-]*\\(free\\)\\s*$", RegexOption.IGNORE_CASE), "").trim()

    fun small(item: ModelPicker.Item): Boolean = item.provider == "kilo" && item.id in small

    fun providerSort(id: String): Int = if (id == "kilo") 0 else 1
}
