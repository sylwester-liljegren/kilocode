package ai.kilocode.client.session.ui

import ai.kilocode.client.plugin.KiloBundle
import ai.kilocode.client.ui.UiStyle
import com.intellij.icons.AllIcons
import com.intellij.ui.CollectionListModel
import com.intellij.ui.GroupHeaderSeparator
import com.intellij.ui.JBColor
import com.intellij.ui.SimpleColoredComponent
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.EmptyIcon
import com.intellij.util.ui.JBFont
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import java.awt.BorderLayout
import java.awt.Component
import java.awt.FlowLayout
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.Point
import java.awt.Rectangle
import java.awt.RenderingHints
import java.awt.Toolkit
import javax.swing.Icon
import javax.swing.JList
import javax.swing.JPanel
import javax.swing.ListCellRenderer
import javax.swing.SwingConstants

private const val FAVORITE_CLICK_AREA_WIDTH = 32

internal class ModelPickerRenderer(
    private val model: CollectionListModel<ModelPickerRow>,
    private val active: () -> String?,
    private val favorites: () -> Set<String>,
) : JPanel(BorderLayout()), ListCellRenderer<ModelPickerRow> {
    companion object {
        const val MAX_ROWS = 10

        val checked: Icon = AllIcons.Actions.Checked
        val empty: Icon = EmptyIcon.create(checked)

        fun isFavoriteClick(list: JList<*>, bounds: Rectangle, point: Point): Boolean {
            val width = JBUI.scale(FAVORITE_CLICK_AREA_WIDTH)
            return if (list.componentOrientation.isLeftToRight) {
                point.x >= bounds.x + bounds.width - width
            } else {
                point.x <= bounds.x + width
            }
        }
    }

    private val sep = GroupHeaderSeparator(JBUI.CurrentTheme.Popup.separatorLabelInsets())
    private val top = JPanel(BorderLayout()).apply {
        border = JBUI.Borders.empty()
        add(sep, BorderLayout.CENTER)
    }
    private val check = JBLabel().apply {
        horizontalAlignment = SwingConstants.CENTER
        verticalAlignment = SwingConstants.CENTER
    }
    private val title = SimpleColoredComponent()
    private val badge = BadgeIcon
    private val provider = JBLabel()
    private val head = JPanel(FlowLayout(FlowLayout.LEFT, 0, 0)).apply {
        add(title)
        add(BadgeLabel(badge).apply {
            border = JBUI.Borders.emptyLeft(JBUI.CurrentTheme.ActionsList.elementIconGap())
        })
        add(provider)
    }
    private val star = JBLabel().apply {
        horizontalAlignment = SwingConstants.CENTER
        verticalAlignment = SwingConstants.CENTER
    }
    private val row = JPanel(BorderLayout()).apply {
        add(check, BorderLayout.WEST)
        add(head, BorderLayout.CENTER)
        add(star, BorderLayout.EAST)
    }

    init {
        isOpaque = true
        top.isOpaque = true
        row.isOpaque = true
        UiStyle.Components.transparent(check)
        UiStyle.Components.transparent(title)
        UiStyle.Components.transparent(head)
        UiStyle.Components.transparent(provider)
        UiStyle.Components.transparent(star)
        row.border = JBUI.Borders.empty(
            UiStyle.Space.MD,
            UiStyle.Space.LG,
            UiStyle.Space.MD,
            UiStyle.Space.LG + UiStyle.Space.SM,
        )
        add(top, BorderLayout.NORTH)
        add(row, BorderLayout.CENTER)
    }

    override fun getListCellRendererComponent(
        list: JList<out ModelPickerRow>,
        value: ModelPickerRow,
        index: Int,
        selected: Boolean,
        focused: Boolean,
    ): Component {
        val focus = selected || list.hasFocus() || focused
        val fg = UIUtil.getListForeground(selected, focus)
        val bg = if (selected) UIUtil.getListBackground(true, focus) else list.background
        val weak = if (selected) fg else UiStyle.Colors.weak()
        val section = modelPickerSectionTitle(model.items, index)

        background = list.background
        top.background = list.background
        row.background = bg
        sep.caption = section
        sep.setHideLine(index == 0)
        top.isVisible = section != null

        check.icon = if (value.item.key == active()) checked else empty
        title.clear()
        val name = ModelText.parts(value.item)
        if (name.provider != null) {
            title.append(name.provider, SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, weak))
            title.append(" ", SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, weak))
        }
        title.append(name.model, SimpleTextAttributes(SimpleTextAttributes.STYLE_BOLD, fg))

        head.getComponent(1).isVisible = value.item.free
        provider.isVisible = value.favorite
        provider.text = value.item.providerName
        provider.foreground = weak
        provider.border = JBUI.Borders.emptyLeft(JBUI.CurrentTheme.ActionsList.elementIconGap())

        val fav = value.item.key in favorites()
        star.icon = when {
            fav -> AllIcons.Nodes.Favorite
            selected -> AllIcons.Nodes.NotFavoriteOnHover
            else -> EmptyIcon.ICON_16
        }
        star.toolTipText = KiloBundle.message(if (fav) "model.picker.favorite.remove" else "model.picker.favorite.add")

        return this
    }

    internal fun starIcon(): Icon? = star.icon

    internal fun badgeVisible(): Boolean = head.getComponent(1).isVisible

    private class BadgeLabel(icon: Icon) : JBLabel(icon)

    private object BadgeIcon : Icon {
        private val text = KiloBundle.message("model.picker.free")

        override fun getIconWidth(): Int {
            val fm = JBFont.small().let { font ->
                @Suppress("DEPRECATION")
                Toolkit.getDefaultToolkit().getFontMetrics(font)
            }
            return fm.stringWidth(text) + JBUI.scale(12)
        }

        override fun getIconHeight(): Int = JBUI.scale(16)

        override fun paintIcon(c: Component?, g: Graphics, x: Int, y: Int) {
            val g2 = g.create() as Graphics2D
            try {
                g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
                g2.translate(x, y)
                g2.color = ModelText.freeBg()
                g2.fillRoundRect(0, 0, iconWidth, iconHeight, JBUI.scale(4), JBUI.scale(4))
                g2.color = JBColor.namedColor("Kilo.ModelPicker.freeBadgeForeground", JBColor.WHITE)
                g2.font = JBFont.small()
                val fm = g2.fontMetrics
                val y = (iconHeight + fm.ascent - fm.descent) / 2
                g2.drawString(text, JBUI.scale(6), y)
            } finally {
                g2.dispose()
            }
        }
    }
}
