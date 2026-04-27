package ai.kilocode.client.session

import ai.kilocode.client.app.KiloAppService
import ai.kilocode.client.app.KiloSessionService
import ai.kilocode.client.app.Workspace
import ai.kilocode.client.session.model.SessionModelEvent
import ai.kilocode.client.session.model.SessionState
import ai.kilocode.client.session.ui.ConnectionPanel
import ai.kilocode.client.session.ui.EmptySessionPanel
import ai.kilocode.client.session.ui.LabelPicker
import ai.kilocode.client.session.ui.PermissionPanel
import ai.kilocode.client.session.ui.PromptPanel
import ai.kilocode.client.session.ui.QuestionPanel
import ai.kilocode.client.session.ui.SessionRootPanel
import ai.kilocode.client.session.ui.SessionMessageListPanel
import ai.kilocode.client.session.update.EVENT_FLUSH_MS
import ai.kilocode.client.session.update.SessionController
import ai.kilocode.client.session.update.SessionControllerEvent
import com.intellij.openapi.Disposable
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.registry.Registry
import ai.kilocode.log.ChatLogSummary
import ai.kilocode.log.KiloLog
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.ui.JBUI
import kotlinx.coroutines.CoroutineScope
import java.awt.BorderLayout
import javax.swing.BoxLayout
import javax.swing.BoxLayout.Y_AXIS
import javax.swing.JPanel

/**
 * Top-level session UI composition root.
 *
 * It builds the session panels, wires controller/model listeners, and swaps the
 * center body between the empty state and the message list.
 */
class SessionUi(
    project: Project,
    workspace: Workspace,
    sessions: KiloSessionService,
    app: KiloAppService,
    cs: CoroutineScope,
) : JPanel(BorderLayout()), Disposable {

    companion object {
        private val LOG = KiloLog.create(SessionUi::class.java)
    }

    private val project = project

    private val flushMs =
        Registry.intValue("kilo.session.flushMs", EVENT_FLUSH_MS.toInt())
            .takeIf { it > 0 }
            ?.toLong()
            ?: EVENT_FLUSH_MS

    private val controller = SessionController(
        this, null, sessions, workspace, app, cs, this,
        flushMs = flushMs,
        condense = Registry.`is`("kilo.session.condense", true),
    )


    private lateinit var root: SessionRootPanel

    private lateinit var sessionContent: JPanel

    private lateinit var emptyBody: EmptySessionPanel

    private lateinit var messageBody: SessionMessageListPanel

    private lateinit var scroll: JBScrollPane

    private lateinit var question: QuestionPanel
    private lateinit var permission: PermissionPanel
    private lateinit var connection: ConnectionPanel

    private lateinit var prompt: PromptPanel


    init {
        buildUi()
        bindUi()
        showBody(emptyBody)
    }

    private fun buildUi() {
        root = SessionRootPanel()

        sessionContent = JPanel(BorderLayout())

        emptyBody = EmptySessionPanel(this)
        messageBody = SessionMessageListPanel(controller.model, this)

        scroll = JBScrollPane(emptyBody).apply {
            border = JBUI.Borders.empty()
            verticalScrollBarPolicy = JBScrollPane.VERTICAL_SCROLLBAR_AS_NEEDED
            horizontalScrollBarPolicy = JBScrollPane.HORIZONTAL_SCROLLBAR_NEVER
        }
        question = QuestionPanel(controller)
        permission = PermissionPanel(controller)
        connection = ConnectionPanel(this, controller)

        prompt = PromptPanel(
            project = project,
            onSend = { text -> sendPrompt(text) },
            onAbort = { controller.abort() },
        )

        sessionContent.add(scroll, BorderLayout.CENTER)
        root.content.add(sessionContent, BorderLayout.CENTER)
        // Dock panels stay in normal flow so each visible state takes layout space
        // above the prompt.
        root.content.add(JPanel().apply {
            this.layout = BoxLayout(this, Y_AXIS)
            add(question)
            add(permission)
            add(connection)
            add(prompt)
        }, BorderLayout.SOUTH)

        add(root, BorderLayout.CENTER)
    }

    private fun bindUi() {
        prompt.mode.onSelect = { item -> controller.selectAgent(item.id) }
        prompt.model.onSelect = picker@{ item ->
            val group = item.group ?: return@picker
            controller.selectModel(group, item.id)
        }

        controller.addListener(this) { event ->
            when (event) {
                is SessionControllerEvent.WorkspaceReady -> {
                    val m = controller.model
                    prompt.mode.setItems(m.agents.map {
                        LabelPicker.Item(
                            it.name,
                            it.display
                        )
                    }, m.agent)
                    val items = m.models.map {
                        LabelPicker.Item(
                            it.id,
                            it.display,
                            it.provider
                        )
                    }
                    val selected =
                        m.model?.let { full -> items.firstOrNull { "${it.group}/${it.id}" == full }?.id }
                    prompt.model.setItems(items, selected)
                    prompt.setReady(m.isReady())
                }

                is SessionControllerEvent.ViewChanged ->
                    showBody(if (event.show) messageBody else emptyBody)

                is SessionControllerEvent.AppChanged,
                is SessionControllerEvent.WorkspaceChanged ->
                    prompt.setReady(controller.model.isReady())
            }
        }

        controller.model.addListener(this) { event ->
            when (event) {
                is SessionModelEvent.StateChanged -> onStateChanged(event.state)

                is SessionModelEvent.TurnAdded,
                is SessionModelEvent.TurnUpdated,
                is SessionModelEvent.ContentAdded,
                is SessionModelEvent.ContentDelta,
                is SessionModelEvent.HistoryLoaded -> scrollToBottom()

                is SessionModelEvent.TurnRemoved,
                is SessionModelEvent.MessageAdded,
                is SessionModelEvent.MessageUpdated,
                is SessionModelEvent.MessageRemoved,
                is SessionModelEvent.ContentUpdated,
                is SessionModelEvent.ContentRemoved,
                is SessionModelEvent.DiffUpdated,
                is SessionModelEvent.TodosUpdated,
                is SessionModelEvent.Compacted,
                is SessionModelEvent.Cleared -> Unit
            }
        }
    }

    private fun sendPrompt(text: String) {
        if (text.isBlank()) return
        LOG.debug {
            "${ChatLogSummary.prompt(text)} agent=${controller.model.agent ?: "none"} model=${controller.model.model ?: "none"} ready=${controller.ready}"
        }
        controller.prompt(text)
        prompt.clear()
    }

    private fun onStateChanged(state: SessionState) {
        prompt.setBusy(state.isBusy())
        when (state) {
            is SessionState.AwaitingQuestion -> {
                permission.hidePanel()
                question.show(state.question)
            }

            is SessionState.AwaitingPermission -> {
                question.hidePanel()
                permission.show(state.permission)
            }

            else -> {
                question.hidePanel()
                permission.hidePanel()
            }
        }
        refresh()
        scrollToBottom()
    }

    private fun scrollToBottom() {
        val bar = scroll.verticalScrollBar
        bar.value = bar.maximum
    }

    private fun refresh() {
        root.revalidate()
        root.repaint()
    }

    private fun showBody(panel: JPanel) {
        if (scroll.viewport.view === panel) return
        scroll.viewport.setView(panel)
        scroll.revalidate()
        scroll.repaint()
    }

    override fun dispose() {}
}
