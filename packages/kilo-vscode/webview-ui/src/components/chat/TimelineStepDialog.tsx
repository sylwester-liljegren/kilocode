import type { Component } from "solid-js"
import { Show } from "solid-js"
import { Dialog } from "@kilocode/kilo-ui/dialog"
import { Button } from "@kilocode/kilo-ui/button"
import { useDialog } from "@kilocode/kilo-ui/context/dialog"
import { useLanguage } from "../../context/language"
import { useProvider } from "../../context/provider"
import type { TimelineMetadata } from "../../utils/timeline/metadata"
import { formatCompactCount, formatCost, formatDuration, formatFullTimestamp } from "../../utils/timeline/format"

interface TimelineStepDialogProps {
  title: string
  metadata?: TimelineMetadata
  onGoToStep: () => void
}

export const TimelineStepDialog: Component<TimelineStepDialogProps> = (props) => {
  const language = useLanguage()
  const provider = useProvider()
  const dialog = useDialog()

  const modelName = () => {
    const id = props.metadata?.modelID
    if (!id) return undefined
    const providerID = props.metadata?.providerID
    const entry = providerID ? provider.providers()[providerID]?.models[id] : undefined
    return entry?.name ?? id
  }

  const goToStep = () => {
    props.onGoToStep()
    dialog.close()
  }

  return (
    <Dialog title={props.title}>
      <div class="timeline-dialog">
        <Show when={props.metadata?.agent}>
          {(agent) => (
            <div class="timeline-dialog-row">
              <span class="timeline-dialog-label">{language.t("timeline.dialog.agent")}</span>
              <span class="timeline-dialog-value">{agent()}</span>
            </div>
          )}
        </Show>
        <Show when={modelName()}>
          {(name) => (
            <div class="timeline-dialog-row">
              <span class="timeline-dialog-label">{language.t("timeline.dialog.model")}</span>
              <span class="timeline-dialog-value">{name()}</span>
            </div>
          )}
        </Show>
        <Show when={props.metadata?.time}>
          {(time) => (
            <>
              <div class="timeline-dialog-row">
                <span class="timeline-dialog-label">{language.t("timeline.dialog.started")}</span>
                <span class="timeline-dialog-value">{formatFullTimestamp(time())}</span>
              </div>
              <Show when={formatDuration(time())}>
                {(duration) => (
                  <div class="timeline-dialog-row">
                    <span class="timeline-dialog-label">{language.t("timeline.dialog.duration")}</span>
                    <span class="timeline-dialog-value">{duration()}</span>
                  </div>
                )}
              </Show>
            </>
          )}
        </Show>
        <Show when={props.metadata?.tokens}>
          {(tokens) => (
            <>
              <div class="timeline-dialog-row">
                <span class="timeline-dialog-label">{language.t("timeline.dialog.tokens")}</span>
                <span class="timeline-dialog-value">
                  {language.t("timeline.dialog.tokensInOut", {
                    input: formatCompactCount(tokens().input),
                    output: formatCompactCount(tokens().output),
                    reasoning: formatCompactCount(tokens().reasoning ?? 0),
                  })}
                </span>
              </div>
              <Show when={(tokens().cache?.read ?? 0) > 0 || (tokens().cache?.write ?? 0) > 0}>
                <div class="timeline-dialog-row">
                  <span class="timeline-dialog-label">{language.t("timeline.dialog.cache")}</span>
                  <span class="timeline-dialog-value">
                    {language.t("timeline.dialog.cacheReadWrite", {
                      read: formatCompactCount(tokens().cache?.read ?? 0),
                      write: formatCompactCount(tokens().cache?.write ?? 0),
                    })}
                  </span>
                </div>
              </Show>
            </>
          )}
        </Show>
        <Show when={props.metadata?.cost !== undefined}>
          <div class="timeline-dialog-row">
            <span class="timeline-dialog-label">{language.t("timeline.dialog.cost")}</span>
            <span class="timeline-dialog-value">{formatCost(props.metadata?.cost ?? 0)}</span>
          </div>
        </Show>
        <div class="timeline-dialog-actions">
          <Button variant="secondary" size="small" onClick={goToStep}>
            {language.t("timeline.menu.goToStep")}
          </Button>
          <Button variant="ghost" size="small" onClick={() => dialog.close()}>
            {language.t("common.close")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
