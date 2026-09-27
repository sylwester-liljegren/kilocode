/**
 * Host-reported failures, as toasts.
 *
 * Both shapes the host uses to report one land here: a PR action's error code, and a plain error
 * message from a worktree action. Neither has anywhere else to go — a message that is posted and
 * dropped leaves its only trace in an output channel nobody opens, which is how a failed action
 * looks like nothing happening at all.
 */
import type { AgentManagerPRErrorMessage } from "../src/types/messages"
import { isCurrent } from "./project/message-ownership"

type Failure = { type?: string; message?: unknown; error?: unknown; projectId?: string }

export interface FailureToastDeps {
  toast: (toast: { variant: "error"; title: string; description: string }) => void
  t: (key: string, params?: Record<string, string>) => string
  /** The project on screen; a failure reported for another one is not shown. */
  project: string | undefined
}

/**
 * Shows a failure report as a toast. Answers "stale" when the message belongs to another project and
 * must not be routed any further, the same contract `routeReview` uses for review messages.
 *
 * Only a PR error carries a project, so only it can be stale. A plain error message is shown and the
 * caller keeps routing, which is what the inline branches this replaced did.
 */
export function reportFailure(msg: Failure, deps: FailureToastDeps): "stale" | undefined {
  if (msg.type === "agentManager.prError") {
    if (!isCurrent(msg, deps.project)) return "stale"
    const pr = msg as AgentManagerPRErrorMessage
    // GitLab/Azure DevOps errors carry the service's own names; GitHub keeps its dedicated copy.
    const key =
      pr.source && pr.error !== "fetch_failed"
        ? `agentManager.pr.error.${pr.error === "gh_auth" ? "cli_auth" : "cli_missing"}`
        : `agentManager.pr.error.${pr.error}`
    deps.toast({
      variant: "error",
      title: deps.t(`${key}.title`, pr.source),
      description: deps.t(`${key}.description`, pr.source),
    })
    return undefined
  }
  if (msg.type !== "error" || typeof msg.message !== "string" || !msg.message) return undefined
  deps.toast({ variant: "error", title: deps.t("agentManager.error.title"), description: msg.message })
  return undefined
}
