import type { ExecFileOptionsWithStringEncoding } from "child_process"
import { execWithShellEnv } from "../shell-env"
import { launch } from "./windows-launch"
import type {
  PRComment,
  PRMergeability,
  PRMergeMethod,
  PRMergeState,
  PRReviewer,
  PRStatus,
  PRTimelineItem,
} from "../types"
import type { PRReactionContent } from "../../../webview-ui/agent-manager/pr/pr-types"

export type ProviderId = "gitlab" | "azuredevops"

/** Identifies one PR/MR on a non-GitHub host. `project` is set only for Azure DevOps. */
export interface PrRef {
  host: string
  owner: string
  repo: string
  number: number
  project?: string
}

export type CliErrorKind = "cli_missing" | "cli_auth" | "not_found" | "unknown"

/** Enough to fetch and check out a PR/MR branch, mirroring git-import.ts's `PRInfo`. */
export interface ProviderPrInfo {
  headRefName: string
  baseRefName?: string
  isCrossRepository: boolean
  /** Git remote name to register for a fork's branch, e.g. a sanitized source-project path. */
  forkOwnerKey?: string
  /** Full clone URL for the fork remote, set together with `forkOwnerKey`. */
  forkRemoteUrl?: string
  title: string
}

/** Merge panel state; the poller adds the user's saved method on top. */
export interface ProviderMerge {
  mergeable: PRMergeability
  state: PRMergeState
  auto: PRMergeMethod | null
  methods: PRMergeMethod[]
  autoAllowed: boolean
  canWrite: boolean
}

export interface ProviderPrStatus {
  title: string
  body?: string
  url: string
  state: PRState
  author?: string
  /** Whether the signed-in CLI user opened this PR; hides "approve" for your own PR, as on GitHub. */
  viewerDidAuthor?: boolean
  createdAt?: string
  baseRefOid?: string
  headRefOid?: string
  checks: PRStatus["checks"]
  reviewers: PRReviewer[]
  merge?: ProviderMerge
}

type PRState = PRStatus["state"]

export interface ProviderThreads {
  comments: PRComment[]
  conversation: PRTimelineItem[]
}

/** What `pr/suggestion-actions.ts` needs to verify a suggestion before touching the worktree. */
export interface SuggestionSource {
  path: string
  side: "LEFT" | "RIGHT"
  line: number
  startLine?: number
  outdated: boolean
  headRefOid: string
  body: string
}

export interface ProviderCommentInput {
  path: string
  side: "LEFT" | "RIGHT"
  line: number
  startLine?: number
  body: string
}

export type ProviderReviewEvent = "approve" | "request_changes" | "comment"

/** User-facing names for the error toast, interpolated into provider-neutral translation keys. */
export interface ProviderLabels {
  service: string
  tool: string
  login: string
}

export interface Provider {
  id: ProviderId
  cliBin: string
  labels: ProviderLabels
  authHint: string
  missingHint: string
  detectHost(remoteUrl: string): boolean
  parsePrUrl(url: string): PrRef | null
  classifyCliError(msg: string): CliErrorKind
  /** Fallback tracking ref fetched when the head branch isn't already present on `origin`. */
  pullRef(ref: PrRef): string
  fetchPrInfo(ref: PrRef, root: string): Promise<ProviderPrInfo>
  fetchStatus(ref: PrRef, root: string): Promise<ProviderPrStatus>
  /** Review threads (diff comments) and the general conversation, mapped to the neutral PR types. */
  fetchThreads(ref: PrRef, root: string, headRefOid: string | undefined): Promise<ProviderThreads>

  /** Parses `git remote get-url origin` (https and ssh forms) into everything but the PR number. */
  parseRemote(remoteUrl: string): Omit<PrRef, "number"> | null
  /** Finds the open PR/MR whose source branch matches, for status polling that only knows a branch. */
  findOpenByBranch(base: Omit<PrRef, "number">, branch: string, root: string): Promise<PrRef | null>
  fetchDiffRefs(ref: PrRef, root: string): Promise<{ baseRefOid: string; headRefOid: string }>

  postComment(ref: PrRef, input: ProviderCommentInput, root: string): Promise<{ id: string }>
  postGeneralComment(ref: PrRef, body: string, root: string): Promise<void>
  submitReview(ref: PrRef, event: ProviderReviewEvent, body: string, headRefOid: string, root: string): Promise<void>
  /** Ids are this provider's own self-describing encoding — see {@link encodeThreadId}. */
  replyThread(threadId: string, body: string, root: string): Promise<void>
  resolveThread(threadId: string, resolved: boolean, root: string): Promise<void>
  editComment(commentId: string, body: string, root: string): Promise<void>
  deleteComment(commentId: string, root: string): Promise<void>
  fetchSuggestionSource(commentId: string, root: string): Promise<SuggestionSource>
  react(commentId: string, content: PRReactionContent, add: boolean, root: string): Promise<void>

  mergePr(ref: PrRef, method: PRMergeMethod, auto: boolean, headRefOid: string, root: string): Promise<void>
  updateBranchFromBase(ref: PrRef, root: string): Promise<void>
  disableAutoMerge(ref: PrRef, root: string): Promise<void>
}

/**
 * Encodes a provider-owned thread/comment identity into the opaque string the neutral PR types
 * carry. Parts are URI-encoded so a project name can never introduce a stray separator.
 */
export function encodeThreadId(providerId: ProviderId, ...parts: (string | number)[]): string {
  return [providerId, ...parts.map((part) => encodeURIComponent(String(part)))].join(":")
}

/** Splits an id built by {@link encodeThreadId} back into its provider id and parts. */
export function decodeThreadId(id: string): { providerId: string; parts: string[] } | undefined {
  const [providerId, ...parts] = id.split(":")
  if (!providerId || parts.length === 0) return undefined
  return { providerId, parts: parts.map((part) => decodeURIComponent(part)) }
}

/** Aggregate review decision from individual reviewer states, mirroring GitHub's `reviewDecision`. */
export function decision(reviewers: PRReviewer[]): PRStatus["review"] {
  if (reviewers.some((item) => item.state === "changes_requested")) return "changes_requested"
  if (reviewers.some((item) => item.state === "approved")) return "approved"
  if (reviewers.length > 0) return "pending"
  return null
}

function env(options?: Omit<ExecFileOptionsWithStringEncoding, "encoding">): NodeJS.ProcessEnv {
  const result = options?.env ? { ...options.env } : { ...process.env }
  const tz = Object.keys(result).find((key) => key.toLowerCase() === "tz")
  if (!tz) result.TZ = "UTC"
  return result
}

/** Run a provider CLI without tzutil console windows flashing on Windows (mirrors gh.ts's execGhRead). */
export function execCliRead(
  bin: string,
  args: string[],
  options?: Omit<ExecFileOptionsWithStringEncoding, "encoding">,
): Promise<{ stdout: string; stderr: string }> {
  if (process.platform !== "win32") return execWithShellEnv(bin, args, options)
  const base = env(options)
  const start = launch(bin, base)
  return execWithShellEnv(start.bin, [...start.prefix, ...args], { ...options, env: { ...base, ...start.env } })
}

export function localBranchNameFor(info: ProviderPrInfo): string {
  if (info.isCrossRepository && info.forkOwnerKey) return `${info.forkOwnerKey}/${info.headRefName}`
  return info.headRefName
}

/** Run async thunks with bounded concurrency, keeping result order. */
export async function bounded<T>(items: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(items.length)
  const state = { next: 0 }
  const run = async () => {
    while (state.next < items.length) {
      const index = state.next++
      results[index] = await items[index]!()
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  return results
}
