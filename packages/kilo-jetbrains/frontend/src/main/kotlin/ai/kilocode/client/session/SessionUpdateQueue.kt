package ai.kilocode.client.session

import ai.kilocode.log.ChatLogSummary
import ai.kilocode.log.KiloLog
import ai.kilocode.rpc.dto.ChatEventDto
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.util.Disposer
import java.awt.Component
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

internal const val EVENT_FLUSH_MS = 150L

internal class SessionUpdateQueue(
    parent: Disposable,
    private val comp: Component?,
    private val flushMs: Long = EVENT_FLUSH_MS,
    private val fire: (List<ChatEventDto>) -> Unit,
    private val condense: Boolean = true,
    hold: Boolean,
    private val sid: () -> String,
) : Disposable {
    companion object {
        private val LOG = KiloLog.create(SessionUpdateQueue::class.java)
    }

    private val app = ApplicationManager.getApplication()
    private val condenser = SessionQueueCondenser()
    private val pending = mutableListOf<ChatEventDto>()
    private val exec: ScheduledExecutorService? = if (flushMs == Long.MAX_VALUE) null else Executors.newSingleThreadScheduledExecutor()
    private var last = 0L
    private var hold = hold

    init {
        Disposer.register(parent, this)
        exec?.scheduleAtFixedRate(
            { requestFlush(false, "tick") },
            flushMs,
            flushMs,
            TimeUnit.MILLISECONDS,
        )
    }

    fun enqueue(event: ChatEventDto) {
        edt {
            LOG.debug { "${ChatLogSummary.sid(sid())} enqueue pending=${pending.size + 1}" }
            pending.add(event)
            flushNow(false, "enqueue")
        }
    }

    fun holdFlush(hold: Boolean) {
        edt {
            LOG.debug { "${ChatLogSummary.sid(sid())} hold=$hold" }
            this.hold = hold
        }
    }

    fun requestFlush(forced: Boolean, source: String = "api") {
        edt { flushNow(forced, source) }
    }

    override fun dispose() {
        LOG.debug { "${ChatLogSummary.sid(sid())} dispose pending=${pending.size}" }
        exec?.shutdownNow()
        if (app.isDispatchThread) {
            pending.clear()
            return
        }
        app.invokeLater { pending.clear() }
    }

    private fun flushNow(forced: Boolean, source: String) {
        if (hold) return
        if (!showing()) return
        if (pending.isEmpty()) return
        val now = System.currentTimeMillis()
        if (!forced && now - last < flushMs) return
        val before = pending.size
        val types = pending.groupBy { it::class.simpleName }
            .entries.joinToString(",") { (k, v) -> "$k:${v.size}" }
        val batch = if (condense) condenser.condense(pending.toList()) else pending.toList()
        pending.clear()
        last = now
        LOG.debug { "${ChatLogSummary.sid(sid())} flush source=$source forced=$forced pending=$before condensed=${batch.size} saved=${before - batch.size} types=$types" }
        fire(batch)
    }

    private fun showing(): Boolean = comp?.isShowing ?: true

    private fun edt(block: () -> Unit) {
        if (app.isDispatchThread) {
            block()
            return
        }
        app.invokeLater(block)
    }
}

