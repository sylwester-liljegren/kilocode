import { Component, Show, createMemo, createSignal } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import { Icon } from "@kilocode/kilo-ui/icon"
import { useNotifications } from "../../context/notifications"
import { useVSCode } from "../../context/vscode"
import { useSession } from "../../context/session"
import { useProvider } from "../../context/provider"
import { KILO_PROVIDER_ID } from "../../../../src/shared/provider-model"

export const KiloNotifications: Component = () => {
  const { filteredNotifications, dismiss } = useNotifications()
  const vscode = useVSCode()
  const session = useSession()
  const provider = useProvider()
  const [index, setIndex] = createSignal(0)

  const items = filteredNotifications
  const total = () => items().length
  const safeIndex = () => Math.min(index(), Math.max(0, total() - 1))
  const current = createMemo(() => (total() === 0 ? undefined : items()[safeIndex()]))

  const prev = () => setIndex((i) => (i - 1 + total()) % total())
  const next = () => setIndex((i) => (i + 1) % total())

  const handleAction = (url: string) => {
    vscode.postMessage({ type: "openExternal", url })
  }

  const handleDismiss = () => {
    const n = current()
    if (!n) return
    dismiss(n.id)
    setIndex((i) => Math.min(i, Math.max(0, total() - 2)))
  }

  /**
   * Resolve a suggestModelId string to a { providerID, modelID } pair.
   * The suggestModelId may be a bare model ID (e.g. "anthropic/claude-sonnet-4-6")
   * which is resolved against the kilo provider first, then all other providers.
   */
  const suggestedModel = createMemo(() => {
    const id = current()?.suggestModelId
    if (!id) return undefined
    const models = provider.models()
    // Try kilo provider first
    const kiloMatch = models.find((m) => m.providerID === KILO_PROVIDER_ID && m.id === id)
    if (kiloMatch) return { providerID: KILO_PROVIDER_ID, modelID: id }
    // Fall back to any provider that has the model
    const match = models.find((m) => m.id === id)
    if (match) return { providerID: match.providerID, modelID: id }
    return undefined
  })

  const canSwitchModel = createMemo(() => {
    const suggestion = suggestedModel()
    if (!suggestion) return false
    const sel = session.selected()
    if (sel && sel.providerID === suggestion.providerID && sel.modelID === suggestion.modelID) return false
    return true
  })

  const handleTryModel = () => {
    const suggestion = suggestedModel()
    if (!suggestion) return
    session.selectModel(suggestion.providerID, suggestion.modelID)
    vscode.postMessage({
      type: "telemetry",
      event: "Notification Clicked",
      properties: { actionText: "Try model", suggestModelId: current()?.suggestModelId },
    })
  }

  return (
    <Show when={total() > 0}>
      <div class="kilo-notifications">
        <div class="kilo-notifications-card">
          <div class="kilo-notifications-header">
            <span class="kilo-notifications-title">{current()?.title}</span>
            <IconButton size="small" variant="ghost" icon="close" onClick={handleDismiss} title="Dismiss" />
          </div>
          <p class="kilo-notifications-message">{current()?.message}</p>
          <div class="kilo-notifications-footer">
            <Show when={total() > 1}>
              <div class="kilo-notifications-nav">
                <button class="kilo-notifications-nav-btn" onClick={prev} title="Previous">
                  <Icon name="arrow-left" size="small" />
                </button>
                <span class="kilo-notifications-nav-count">
                  {safeIndex() + 1} / {total()}
                </span>
                <button class="kilo-notifications-nav-btn" onClick={next} title="Next">
                  <Icon name="arrow-right" size="small" />
                </button>
              </div>
            </Show>
            <Show when={canSwitchModel()}>
              <Button variant="primary" size="small" onClick={handleTryModel}>
                Try model
              </Button>
            </Show>
            <Show when={current()?.action}>
              {(action) => (
                <Button variant="primary" size="small" onClick={() => handleAction(action().actionURL)}>
                  {action().actionText}
                </Button>
              )}
            </Show>
          </div>
        </div>
      </div>
    </Show>
  )
}
