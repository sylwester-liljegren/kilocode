package ai.kilocode.client.session.ui

import ai.kilocode.client.session.update.SessionController
import ai.kilocode.client.session.update.SessionControllerTestBase
import ai.kilocode.rpc.dto.ConfigWarningDto
import ai.kilocode.rpc.dto.KiloAppStateDto
import ai.kilocode.rpc.dto.KiloAppStatusDto
import ai.kilocode.rpc.dto.KiloWorkspaceStateDto
import ai.kilocode.rpc.dto.KiloWorkspaceStatusDto
import ai.kilocode.rpc.dto.LoadErrorDto
import java.awt.Dimension

@Suppress("UnstableApiUsage")
class ConnectionPanelTest : SessionControllerTestBase() {

    private lateinit var panel: ConnectionPanel
    private lateinit var controller: SessionController

    override fun setUp() {
        super.setUp()
        controller = controller("ses_test")
        panel = ConnectionPanel(parent, controller)
        flush()
    }

    fun `test loading hides retry and details`() {
        edt {
            controller.model.app = KiloAppStateDto(KiloAppStatusDto.CONNECTING)
            controller.model.workspace = KiloWorkspaceStateDto(KiloWorkspaceStatusDto.PENDING)
            panel.onEvent(ai.kilocode.client.session.update.SessionControllerEvent.AppChanged)
        }

        assertTrue(panel.isVisible)
        assertEquals("Loading...", panel.summaryText())
        assertEquals("", panel.detailsText())
        assertFalse(panel.toggleVisible())
        assertFalse(panel.detailsVisible())
        assertFalse(panel.retryVisible())
    }

    fun `test app error starts collapsed and expands details`() {
        edt {
            controller.model.app = KiloAppStateDto(
                status = KiloAppStatusDto.ERROR,
                error = "CLI startup failed",
                errors = listOf(
                    LoadErrorDto(resource = "connection", detail = "stderr line"),
                    LoadErrorDto(resource = "config", detail = "HTTP 500: broken"),
                ),
            )
            panel.onEvent(ai.kilocode.client.session.update.SessionControllerEvent.AppChanged)
        }

        assertTrue(panel.isVisible)
        assertEquals("CLI startup failed", panel.summaryText())
        assertTrue(panel.toggleVisible())
        assertFalse(panel.toggleExpanded())
        assertFalse(panel.detailsVisible())
        assertEquals("stderr line\nconfig: HTTP 500: broken", panel.detailsText())
        assertTrue(panel.retryVisible())
        assertFalse(panel.retryFocusable())

        edt { panel.clickSummary() }

        assertTrue(panel.toggleExpanded())
        assertTrue(panel.detailsVisible())

        edt { panel.clickToggle() }

        assertFalse(panel.toggleExpanded())
        assertFalse(panel.detailsVisible())
    }

    fun `test workspace error shows retry without details`() {
        edt {
            controller.model.app = KiloAppStateDto(KiloAppStatusDto.READY)
            controller.model.workspace = KiloWorkspaceStateDto(
                status = KiloWorkspaceStatusDto.ERROR,
                error = "Workspace failed",
            )
            panel.onEvent(ai.kilocode.client.session.update.SessionControllerEvent.WorkspaceChanged)
        }

        assertTrue(panel.isVisible)
        assertEquals("Workspace failed", panel.summaryText())
        assertFalse(panel.toggleVisible())
        assertFalse(panel.detailsVisible())
        assertEquals("", panel.detailsText())
        assertTrue(panel.retryVisible())
    }

    fun `test retry click triggers app retry for app error`() {
        edt {
            controller.model.app = KiloAppStateDto(
                status = KiloAppStatusDto.ERROR,
                error = "CLI startup failed",
            )
            panel.onEvent(ai.kilocode.client.session.update.SessionControllerEvent.AppChanged)
        }
        edt { panel.clickRetry() }
        flush()

        assertEquals(1, appRpc.retries)
    }

    fun `test ready warnings show collapsed banner with retry`() {
        edt {
            controller.model.app = KiloAppStateDto(
                status = KiloAppStatusDto.READY,
                warnings = listOf(
                    ConfigWarningDto(
                        path = ".kilo/kilo.json",
                        message = "Invalid JSON",
                        detail = "CloseBraceExpected at line 11, column 1",
                    )
                ),
            )
            controller.model.workspace = KiloWorkspaceStateDto(KiloWorkspaceStatusDto.READY)
            panel.onEvent(ai.kilocode.client.session.update.SessionControllerEvent.AppChanged)
        }

        assertTrue(panel.isVisible)
        assertEquals("Configuration warnings", panel.summaryText())
        assertTrue(panel.toggleVisible())
        assertFalse(panel.toggleExpanded())
        assertFalse(panel.detailsVisible())
        assertTrue(panel.retryVisible())
        assertFalse(panel.retryFocusable())
        assertEquals(
            ".kilo/kilo.json: Invalid JSON\nCloseBraceExpected at line 11, column 1",
            panel.detailsText(),
        )

        edt { panel.clickSummary() }

        assertTrue(panel.toggleExpanded())
        assertTrue(panel.detailsVisible())
    }

    fun `test retry click triggers app retry for warnings`() {
        edt {
            controller.model.app = KiloAppStateDto(
                status = KiloAppStatusDto.READY,
                warnings = listOf(ConfigWarningDto(path = ".kilo/kilo.json", message = "Invalid JSON")),
            )
            controller.model.workspace = KiloWorkspaceStateDto(KiloWorkspaceStatusDto.READY)
            panel.onEvent(ai.kilocode.client.session.update.SessionControllerEvent.AppChanged)
        }
        edt { panel.clickRetry() }
        flush()

        assertEquals(1, appRpc.retries)
    }

    fun `test expanded details height is capped at ten lines`() {
        edt {
            controller.model.app = KiloAppStateDto(
                status = KiloAppStatusDto.ERROR,
                error = "CLI startup failed",
                errors = listOf(LoadErrorDto(resource = "connection", detail = lines(30))),
            )
            panel.onEvent(ai.kilocode.client.session.update.SessionControllerEvent.AppChanged)
            panel.size = Dimension(480, 1000)
        }

        edt { panel.clickSummary() }

        assertTrue(panel.detailsVisible())
        assertTrue(panel.preferredSize.height <= panel.maxExpandedHeight())
    }

    private fun lines(count: Int) = (1..count).joinToString("\n") { "line $it" }
}
