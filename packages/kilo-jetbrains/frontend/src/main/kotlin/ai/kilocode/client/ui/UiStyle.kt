package ai.kilocode.client.ui

import com.intellij.ui.JBColor
import com.intellij.ui.RoundedLineBorder
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import java.awt.BorderLayout
import java.awt.Color
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.UIManager
import javax.swing.border.Border

/** Static UI tokens and helpers for JetBrains session Swing surfaces. */
object UiStyle {
    object Size {
        const val WIDTH = 350
        const val LIMIT = 5
        const val LINES = 3
        const val CHROME = 16
        const val BUTTON_WIDTH = 28
        const val BUTTON = 24
        const val SCROLL = 16
    }

    object Space {
        const val XS = 2
        const val SM = 4
        const val MD = 6
        const val LG = 8
        const val XL = 10
        const val PAD = 12
        const val LOGO = 14
        const val RECENT = 28
    }

    object Colors {
        fun bg(): Color = UIUtil.getPanelBackground()

        fun fg(): Color = UIUtil.getLabelForeground()

        fun weak(): Color = UIUtil.getContextHelpForeground()

        fun line(): Color = JBColor.border()

        fun surface(): Color = JBColor.lazy {
            UIManager.getColor("TextField.background") ?: UIUtil.getPanelBackground()
        }

        fun error(): Color = JBColor.namedColor("Label.errorForeground", UIUtil.getErrorForeground())

        fun warning(): Color = JBColor.lazy {
            UIManager.getColor("Component.warningFocusColor")
                ?: UIManager.getColor("Label.warningForeground")
                ?: UIUtil.getContextHelpForeground()
        }

        fun running(): Color = JBColor.namedColor("ProgressBar.foreground", UIUtil.getLabelForeground())
    }

    object Insets {
        fun transcript(): Border = JBUI.Borders.empty(Space.PAD, Space.PAD)

        fun empty(): Border = JBUI.Borders.empty(Space.PAD)

        fun prompt(): Border = JBUI.Borders.empty(Space.LG, Space.PAD, Space.LG, Space.PAD)

        fun header(): Border = JBUI.Borders.empty(Space.LG, Space.XL)

        fun body(): Border = JBUI.Borders.empty(Space.LG, Space.XL)

        fun progress(): Border = JBUI.Borders.empty(Space.MD, 0, Space.SM, 0)
    }

    object Borders {
        fun card(): Border = JBUI.Borders.customLine(Colors.line(), 1)

        fun cardTop(): Border = JBUI.Borders.customLineTop(Colors.line())

        fun warning(): Border = JBUI.Borders.customLine(Colors.warning(), 1)

        fun picker(): Border = JBUI.Borders.compound(
          RoundedLineBorder(Colors.line(), JBUI.scale(Space.MD)),
            JBUI.Borders.empty(Space.XS, Space.LG),
        )!!

        fun user(): Border = JBUI.Borders.compound(
            JBUI.Borders.customLineTop(Colors.line()),
            JBUI.Borders.empty(Space.LG, 0, Space.SM, 0),
        )!!

        fun assistant(): Border = JBUI.Borders.empty(Space.SM, 0)
    }

    object Dock {
        fun banner(): Border = JBUI.Borders.compound(
            JBUI.Borders.customLineTop(Colors.line()),
            JBUI.Borders.empty(Space.SM, Space.LG, 0, Space.LG),
        )!!

        fun neutral(): Border = JBUI.Borders.compound(
            JBUI.Borders.customLine(Colors.line(), 1),
            JBUI.Borders.empty(Space.LG, Space.PAD),
        )!!

        fun warning(): Border = JBUI.Borders.compound(
            Borders.warning(),
            JBUI.Borders.empty(Space.LG, Space.PAD),
        )!!
    }

    object Gap {
        fun inline() = JBUI.scale(Space.MD)

        fun regular() = JBUI.scale(Space.LG)

        fun small() = JBUI.scale(Space.SM)

        fun turn() = JBUI.scale(Space.PAD)

        fun part() = JBUI.scale(Space.SM)

        fun scroll() = JBUI.scale(Size.SCROLL)

        fun layout(gap: Int = Space.LG) = BorderLayout(JBUI.scale(gap), 0)
    }

    object Buttons {
        fun icon(button: JButton) {
            button.isFocusable = false
            button.setRequestFocusEnabled(false)
            button.isContentAreaFilled = false
            button.isBorderPainted = false
            button.isOpaque = false
            button.border = JBUI.Borders.empty()
        }
    }

    object Components {
        fun transparent(component: JComponent) {
            component.isOpaque = false
        }
    }
}
