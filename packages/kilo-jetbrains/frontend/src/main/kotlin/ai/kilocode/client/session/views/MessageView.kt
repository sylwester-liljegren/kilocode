package ai.kilocode.client.session.views

import ai.kilocode.client.session.model.Content
import ai.kilocode.client.session.model.Message
import ai.kilocode.client.session.ui.SessionStyle
import ai.kilocode.client.session.ui.SessionStyleTarget
import ai.kilocode.client.ui.UiStyle

/**
 * A single message container inside a [TurnView].
 *
 * Holds an ordered map of [PartView]s keyed by part id. The layout is
 * driven by [ai.kilocode.client.session.ui.SessionLayout] so that each
 * part view gets the full available width and height is computed correctly
 * for HTML-backed views.
 *
 * Styling:
 * - User messages: 1 px top separator + extra top padding to create a
 *   visual turn boundary.
 * - Assistant messages: light padding only.
 */
class MessageView(
    val msg: Message,
    private var style: SessionStyle = SessionStyle.current(),
) : ai.kilocode.client.session.ui.SessionLayoutPanel(), SessionStyleTarget {

    constructor(msg: Message) : this(msg, SessionStyle.current())

    val role: String get() = msg.info.role

    private val parts = LinkedHashMap<String, PartView>()

    init {
        isOpaque = false
        border = if (msg.info.role == "user") {
            UiStyle.Borders.user()
        } else {
            UiStyle.Borders.assistant()
        }

        // Populate content that already exists (e.g. after loadHistory)
        for ((_, content) in msg.parts) {
            val view = ViewFactory.create(content)
            view.applyStyle(style)
            parts[content.id] = view
            add(view)
        }
    }

    /** Add or update the renderer for [content]. */
    fun upsertPart(content: Content) {
        val existing = parts[content.id]
        if (existing != null) {
            existing.update(content)
            revalidate()
            repaint()
            return
        }
        val view = ViewFactory.create(content)
        view.applyStyle(style)
        parts[content.id] = view
        add(view)
        revalidate()
        repaint()
    }

    /** Remove the renderer for [contentId] if present. */
    fun removePart(contentId: String) {
        val view = parts.remove(contentId) ?: return
        remove(view)
        revalidate()
        repaint()
    }

    /** Append a streaming delta to the renderer for [contentId]. */
    fun appendDelta(contentId: String, delta: String) {
        parts[contentId]?.appendDelta(delta)
        revalidate()
        repaint()
    }

    /** Look up a renderer by part id. */
    fun part(id: String): PartView? = parts[id]

    /** Ordered part ids — stable for test assertions. */
    fun partIds(): List<String> = parts.keys.toList()

    /** Compact dump for test assertions. */
    fun dump(): String = parts.values.joinToString(", ") { it.dumpLabel() }

    override fun applyStyle(style: SessionStyle) {
        this.style = style
        for (view in parts.values) view.applyStyle(style)
        revalidate()
        repaint()
    }
}
