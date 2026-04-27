/**
 * Permission handlers — extracted from KiloProvider.
 *
 * Manages permission responses (once/always/reject) and recovery of
 * pending permissions after SSE reconnections. No vscode dependency.
 */

import type { KiloClient, PermissionRequest } from "@kilocode/sdk/v2/client"

export type RecoverablePermission = PermissionRequest

export interface PermissionContext {
  readonly client: KiloClient | null
  readonly currentSessionId: string | undefined
  readonly trackedSessionIds: Set<string>
  readonly sessionDirectories: ReadonlyMap<string, string>
  postMessage(msg: unknown): void
  getWorkspaceDirectory(sessionId?: string): string
  /**
   * Record the SSE envelope directory for a pending permission. Used so that
   * replies land in the Instance that actually holds the pending entry,
   * regardless of any stale session→directory mapping.
   */
  recordPermissionDirectory(requestID: string, directory: string): void
  /** Look up the directory recorded for a pending permission, if any. */
  getPermissionDirectory(requestID: string): string | undefined
  /** Clear a cached directory record when the permission is no longer pending. */
  clearPermissionDirectory(requestID: string): void
  /** Remove directory entries for permissions no longer in the active set. */
  prunePermissionDirectories(active: Set<string>): void
}

export function recoveryDirs(workspace: string, dirs: ReadonlyMap<string, string>) {
  return [...new Set([workspace, ...dirs.values()])]
}

export function recoverablePermissions(perms: RecoverablePermission[], tracked: Set<string>, seen: Set<string>) {
  return perms.filter((perm) => {
    if (seen.has(perm.id)) return false
    seen.add(perm.id)
    return tracked.has(perm.sessionID)
  })
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const obj = error as Record<string, unknown>
  if (obj.name === "NotFoundError") return true
  if (typeof obj.status === "number" && obj.status === 404) return true
  // SDK `throwOnError: true` shape: { data: { name: "NotFoundError", data: {...} } }
  const data = obj.data as Record<string, unknown> | undefined
  return data?.name === "NotFoundError"
}

/**
 * Handle permission response from the webview.
 * Calls saveAlwaysRules first (if any), then reply — sequentially to avoid races.
 *
 * Routes the request to the Instance that owns the pending permission by
 * using the directory recorded from the `permission.asked` SSE envelope. This
 * avoids mis-routing when `sessionDirectories` is stale (e.g. worktree sessions
 * created by subagents or in a different panel).
 *
 * On a 404 (pending permission gone — typically because another panel replied
 * first), posts `permissionError` (with `stale`) to unstick the UI and refreshes
 * the pending list so the stale entry is removed from the webview.
 */
export async function handlePermissionResponse(
  ctx: PermissionContext,
  permissionId: string,
  sessionID: string,
  response: "once" | "always" | "reject",
  approvedAlways: string[],
  deniedAlways: string[],
): Promise<void> {
  if (!ctx.client) {
    ctx.postMessage({ type: "permissionError", permissionID: permissionId })
    return
  }

  const target = sessionID || ctx.currentSessionId
  if (!target) {
    console.error("[Kilo New] KiloProvider: No sessionID for permission response")
    ctx.postMessage({ type: "permissionError", permissionID: permissionId })
    return
  }

  // Prefer the directory captured from the SSE envelope — that's the Instance
  // whose pending map actually holds this permission. Fall back to the session
  // directory heuristic only for recovered entries with no envelope record.
  const dir = ctx.getPermissionDirectory(permissionId) ?? ctx.getWorkspaceDirectory(target)

  const staleCleanup = () => {
    ctx.clearPermissionDirectory(permissionId)
    ctx.postMessage({ type: "permissionError", permissionID: permissionId, stale: true })
    void fetchAndSendPendingPermissions(ctx)
  }

  // Save per-pattern rules before replying (reply deletes the pending request).
  // On 404 here, skip reply entirely — the pending is gone so reply would 404
  // too, and both paths converge on the same stale-cleanup.
  if (approvedAlways.length > 0 || deniedAlways.length > 0) {
    const saveResult = await ctx.client.permission
      .saveAlwaysRules(
        {
          requestID: permissionId,
          directory: dir,
          approvedAlways,
          deniedAlways,
        },
        { throwOnError: true },
      )
      .then(() => "ok" as const)
      .catch((error: unknown) => {
        if (isNotFoundError(error)) return "stale" as const
        console.error("[Kilo New] KiloProvider: Failed to save always-rules:", error)
        ctx.postMessage({ type: "permissionError", permissionID: permissionId })
        return "error" as const
      })
    if (saveResult === "stale") {
      staleCleanup()
      return
    }
    if (saveResult === "error") return
  }

  const replyResult = await ctx.client.permission
    .reply({ requestID: permissionId, reply: response, directory: dir }, { throwOnError: true })
    .then(() => "ok" as const)
    .catch((error: unknown) => {
      if (isNotFoundError(error)) return "stale" as const
      console.error("[Kilo New] KiloProvider: Failed to respond to permission:", error)
      ctx.postMessage({ type: "permissionError", permissionID: permissionId })
      return "error" as const
    })
  if (replyResult === "stale") {
    staleCleanup()
  }
}

/**
 * Fetch all pending permissions from the backend and forward any that belong
 * to tracked sessions to the webview. Called after SSE reconnects and after
 * loading messages for a session so that missed permission.asked events are
 * recovered instead of leaving the server blocked indefinitely.
 *
 * Each recovered permission is also recorded in the per-permission directory
 * map so subsequent replies route to the exact Instance it was fetched from.
 * Stale entries (permissions no longer pending on any backend) are pruned so
 * the map does not grow without bound.
 */
export async function fetchAndSendPendingPermissions(ctx: PermissionContext): Promise<void> {
  if (!ctx.client) return
  try {
    const dirs = recoveryDirs(ctx.getWorkspaceDirectory(), ctx.sessionDirectories)

    const seen = new Set<string>()
    for (const dir of dirs) {
      const { data } = await ctx.client.permission.list({ directory: dir })
      if (!data) continue
      for (const perm of recoverablePermissions(data, ctx.trackedSessionIds, seen)) {
        ctx.recordPermissionDirectory(perm.id, dir)
        ctx.postMessage({
          type: "permissionRequest",
          permission: {
            id: perm.id,
            sessionID: perm.sessionID,
            toolName: perm.permission,
            patterns: perm.patterns,
            always: perm.always,
            args: perm.metadata,
            message: `Permission required: ${perm.permission}`,
            tool: perm.tool,
          },
        })
      }
    }
    // Remove directory entries for permissions that are no longer pending on
    // any backend Instance, preventing unbounded growth of the map.
    ctx.prunePermissionDirectories(seen)
  } catch (error) {
    console.error("[Kilo New] KiloProvider: Failed to fetch pending permissions:", error)
  }
}
