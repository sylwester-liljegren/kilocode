package ai.kilocode.client.session.ui

import ai.kilocode.client.ui.UiStyle
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.ui.popup.PopupShowOptions
import com.intellij.ui.components.JBLabel
import java.awt.Cursor
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.ListSelectionModel

class ModePicker : JBLabel() {

    data class Item(
        val id: String,
        val display: String,
        val description: String? = null,
        val deprecated: Boolean = false,
    ) {
        override fun toString(): String = listOfNotNull(display, description).joinToString(" ")
    }

    var onSelect: (Item) -> Unit = {}

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
        items = values.sortedWith(compareBy<Item> { it.display.lowercase() }.thenBy { it.id })
        selected = if (default != null) items.firstOrNull { it.id == default } else items.firstOrNull()
        refresh()
    }

    fun select(id: String) {
        selected = items.firstOrNull { it.id == id }
        refresh()
    }

    internal fun itemsForTest(): List<Item> = items

    private fun refresh() {
        if (items.isEmpty()) {
            isEnabled = false
            text = " "
            cursor = Cursor.getDefaultCursor()
            return
        }
        val display = selected?.display ?: items.firstOrNull()?.display ?: ""
        text = "$display ▴"
        isEnabled = true
        cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
    }

    private fun showPopup() {
        val item = selected ?: items.first()
        val popup = JBPopupFactory.getInstance()
            .createPopupChooserBuilder(items)
            .setRenderer(ModePickerRenderer { selected?.id })
            .setSelectionMode(ListSelectionModel.SINGLE_SELECTION)
            .setSelectedValue(item, true)
            .setVisibleRowCount(minOf(ModePickerRenderer.MAX_ROWS, items.size.coerceAtLeast(1)))
            .setRequestFocus(true)
            .setCancelOnClickOutside(true)
            .setCancelKeyEnabled(true)
            .setResizable(false)
            .setMovable(false)
            .setItemChosenCallback { value ->
                selected = value
                refresh()
                onSelect(value)
            }
            .createPopup()

        popup.show(PopupShowOptions.aboveComponent(this))
    }
}
