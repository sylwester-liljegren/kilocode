import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  CheckStatus,
  PRCheck,
  PRComment,
  PRCommentReply,
  PRConversationComment,
  PRMergeMethod,
  PRMergeState,
  PRCommitItem,
  PREventItem,
  PREventKind,
  PRTimelineItem,
  PRReaction,
  PRReactionContent,
  PRReviewer,
} from "../types"
import { execWithShellEnv } from "../shell-env"
import { formatCheckDuration, summarize } from "../pr/am-pr-utils"
import {
  decodeThreadId,
  encodeThreadId,
  execCliRead,
  type CliErrorKind,
  type PrRef,
  type Provider,
  type ProviderCommentInput,
  type ProviderMerge,
  type ProviderPrInfo,
  type ProviderPrStatus,
  type ProviderReviewEvent,
  type ProviderThreads,
  type SuggestionSource,
} from "./provider"

const AZ = "az"
/** `az devops invoke` defaults to REST 5.0, which predates `completionOptions.mergeStrategy`. */
const API = "7.1"

interface AzIdentity {
  id?: string
  uniqueName?: string
  displayName?: string
}

interface AzRepo {
  name?: string
  webUrl?: string
  remoteUrl?: string
  project?: { name?: string }
}

interface AzPr {
  pullRequestId: number
  title: string
  description?: string
  status: string
  isDraft?: boolean
  sourceRefName: string
  targetRefName: string
  createdBy?: AzIdentity
  creationDate?: string
  repository?: AzRepo
  /** Set when the source branch lives in a fork of the target repository. */
  forkSource?: { name?: string; repository?: AzRepo } | null
  closedDate?: string
  closedBy?: AzIdentity | null
  lastMergeSourceCommit?: { commitId?: string }
  lastMergeTargetCommit?: { commitId?: string }
  mergeStatus?: string
  autoCompleteSetBy?: AzIdentity
  completionOptions?: { mergeStrategy?: string; squashMerge?: boolean } & Record<string, unknown>
  reviewers?: Array<AzIdentity & { vote?: number; isContainer?: boolean }>
}

interface AzPolicy {
  status?: string
  startedDate?: string
  completedDate?: string
  context?: { buildId?: number } | null
  configuration?: {
    isEnabled?: boolean
    isBlocking?: boolean
    type?: { displayName?: string }
    settings?: Record<string, unknown> & { displayName?: string }
  }
}

interface AzStatus {
  id?: number
  state?: string
  description?: string
  targetUrl?: string
  context?: { name?: string; genre?: string }
}

interface AzComment {
  id: number
  parentCommentId?: number
  author?: AzIdentity
  content?: string
  publishedDate?: string
  commentType?: string
  isDeleted?: boolean
  usersLiked?: AzIdentity[]
}

interface AzPoint {
  line?: number
}

interface AzThread {
  id: number
  status?: string
  isDeleted?: boolean
  threadContext?: {
    filePath?: string
    rightFileStart?: AzPoint | null
    rightFileEnd?: AzPoint | null
    leftFileStart?: AzPoint | null
    leftFileEnd?: AzPoint | null
  } | null
  comments?: AzComment[]
  publishedDate?: string
  /** System threads describe lifecycle changes here, e.g. `CodeReviewThreadType: StatusUpdate`. */
  properties?: Record<string, { $value?: unknown } | undefined>
  identities?: Record<string, AzIdentity>
}

interface AzIteration {
  id: number
  reason?: string
  createdDate?: string
  author?: AzIdentity
  sourceRefCommit?: { commitId?: string }
}

interface AzCommit {
  commitId: string
  comment?: string
  author?: { name?: string; date?: string }
  committer?: { name?: string; date?: string }
}

const RESOLVED = new Set(["fixed", "wontFix", "closed", "byDesign"])
const STRATEGY: Record<PRMergeMethod, string> = { merge: "noFastForward", squash: "squash", rebase: "rebase" }

function stripHeads(ref: string): string {
  return ref.replace(/^refs\/heads\//, "")
}

function state(pr: Pick<AzPr, "status" | "isDraft">): ProviderPrStatus["state"] {
  if (pr.status === "completed") return "merged"
  if (pr.status === "abandoned") return "closed"
  if (pr.isDraft) return "draft"
  return "open"
}

function vote(value: number | undefined): PRReviewer["state"] {
  if (value === 10 || value === 5) return "approved"
  if (value === -10 || value === -5) return "changes_requested"
  return "pending"
}

function policyStatus(value: string | undefined): CheckStatus {
  if (value === "approved") return "success"
  if (value === "rejected" || value === "broken") return "failure"
  if (value === "notApplicable") return "skipped"
  return "pending"
}

function statusState(value: string | undefined): CheckStatus {
  if (value === "succeeded") return "success"
  if (value === "failed" || value === "error") return "failure"
  if (value === "notApplicable") return "skipped"
  return "pending"
}

function method(strategy: string | undefined, squash: boolean | undefined): PRMergeMethod {
  if (strategy === "squash" || (!strategy && squash)) return "squash"
  if (strategy === "rebase" || strategy === "rebaseMerge") return "rebase"
  return "merge"
}

function time(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : undefined
}

function same(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase()
}

function byTime(a: PRTimelineItem, b: PRTimelineItem): number {
  return (a.createdAt ?? 0) - (b.createdAt ?? 0)
}

/** Where a thread sits in the diff, or `undefined` for a general (non-file) thread. */
function place(context: AzThread["threadContext"]) {
  const right = context?.rightFileEnd?.line
  const left = context?.leftFileEnd?.line
  const line = right ?? left
  if (!context?.filePath || line == null) return undefined
  const start = right != null ? context.rightFileStart?.line : context.leftFileStart?.line
  return {
    path: context.filePath.replace(/^\//, ""),
    side: right != null ? ("RIGHT" as const) : ("LEFT" as const),
    line,
    startLine: start != null && start !== line ? start : undefined,
  }
}

interface Mapping {
  id: (thread: number, comment: number) => string
  viewer: string | undefined
  url: (thread: number) => string
}

/** Azure DevOps "likes" are its only reaction; shown as a thumbs-up. */
function likes(item: AzComment, viewer: string | undefined): PRReaction[] | undefined {
  const users = item.usersLiked ?? []
  if (users.length === 0) return undefined
  const mine = users.some((user) => same(user.uniqueName, viewer))
  return [{ content: "THUMBS_UP", count: users.length, viewerHasReacted: mine }]
}

function reply(map: Mapping, thread: number, item: AzComment): PRCommentReply & { id: string } {
  const own = same(item.author?.uniqueName, map.viewer)
  return {
    id: map.id(thread, item.id),
    canEdit: own,
    canDelete: own,
    author: item.author?.uniqueName ?? item.author?.displayName ?? "unknown",
    body: item.content ?? "",
    createdAt: time(item.publishedDate),
    url: map.url(thread),
    reactions: likes(item, map.viewer),
  }
}

function issue(map: Mapping, thread: number, item: AzComment): PRConversationComment {
  return { kind: "issue", ...reply(map, thread, item) }
}

function prop(thread: AzThread, key: string): string | undefined {
  const value = thread.properties?.[key]?.$value
  return typeof value === "string" ? value : undefined
}

function who(identity: AzIdentity | null | undefined): string {
  return identity?.uniqueName ?? identity?.displayName ?? "unknown"
}

/** Git remote name for a fork, derived from its project and repository names. */
function forkKey(repo: AzRepo): string {
  return `fork-${repo.project?.name ?? ""}-${repo.name ?? ""}`
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+$/, "")
    .toLowerCase()
}

function statusEvent(status: string | undefined, abandoned: boolean): PREventKind | undefined {
  if (status === "Completed") return "merged"
  if (status === "Abandoned") return "closed"
  if (status === "Active" && abandoned) return "reopened"
  return undefined
}

/**
 * Merged/closed/reopened from `StatusUpdate` system threads. Azure DevOps also records "Active" when
 * a PR is published, so "Active" only counts as reopened after an abandon.
 */
function statusEvents(threads: AzThread[], target: string): PREventItem[] {
  const updates = threads
    .filter((thread) => prop(thread, "CodeReviewThreadType") === "StatusUpdate")
    .map((thread) => ({ thread, created: time(thread.publishedDate ?? thread.comments?.at(0)?.publishedDate) }))
    .sort((a, b) => (a.created ?? 0) - (b.created ?? 0))
  const state = { abandoned: false }
  const items: PREventItem[] = []
  for (const { thread, created } of updates) {
    const status = prop(thread, "CodeReviewStatus")
    const event = statusEvent(status, state.abandoned)
    if (status === "Abandoned") state.abandoned = true
    if (status === "Active" || status === "Completed") state.abandoned = false
    if (!event) continue
    const by = prop(thread, "CodeReviewStatusUpdatedByIdentity")
    const actor = (by ? thread.identities?.[by] : undefined) ?? thread.comments?.at(0)?.author
    items.push({
      kind: "event",
      event,
      id: `status:${thread.id}`,
      actor: who(actor),
      createdAt: created,
      ...(event === "merged" ? { detail: target } : {}),
    })
  }
  return items
}

/** Final state from the PR itself, for PRs whose history has no status thread for it. */
function closure(pr: AzPr, target: string, events: PREventItem[]): PREventItem[] {
  const event = pr.status === "completed" ? "merged" : pr.status === "abandoned" ? "closed" : undefined
  if (!event || events.some((item) => item.event === event)) return []
  const item: PREventItem = {
    kind: "event",
    event,
    id: `closed:${pr.pullRequestId}`,
    actor: who(pr.closedBy),
    createdAt: time(pr.closedDate),
    ...(event === "merged" ? { detail: target } : {}),
  }
  return [item]
}

/** Iterations record force pushes; the detail is the previous and new head, like GitHub's event. */
function pushEvents(iterations: AzIteration[]): PREventItem[] {
  const sorted = [...iterations].sort((a, b) => a.id - b.id)
  const items: PREventItem[] = []
  for (const [index, item] of sorted.entries()) {
    if (!item.reason?.includes("forcePush")) continue
    const before = index > 0 ? sorted[index - 1]?.sourceRefCommit?.commitId : undefined
    const after = item.sourceRefCommit?.commitId
    items.push({
      kind: "event",
      event: "force_pushed",
      id: `push:${item.id}`,
      actor: who(item.author),
      createdAt: time(item.createdDate),
      ...(before && after ? { detail: `${before.slice(0, 7)} to ${after.slice(0, 7)}` } : {}),
    })
  }
  return items
}

function commitItems(commits: AzCommit[], web: string | undefined): PRCommitItem[] {
  return commits
    .filter((commit) => typeof commit.commitId === "string")
    .map((commit) => ({
      kind: "commit",
      id: `commit:${commit.commitId}`,
      sha: commit.commitId,
      short: commit.commitId.slice(0, 7),
      message: (commit.comment ?? "").split("\n").at(0) ?? "",
      author: commit.author?.name ?? "unknown",
      createdAt: time(commit.committer?.date ?? commit.author?.date),
      ...(web ? { url: `${web}/commit/${commit.commitId}` } : {}),
    }))
}

/** A file thread as a review thread; `undefined` for a general thread or one with no visible comments. */
function review(map: Mapping, thread: AzThread, list: AzComment[]): PRComment | undefined {
  const first = list.at(0)
  const at = place(thread.threadContext)
  if (!first || !at) return undefined
  const root = reply(map, thread.id, first)
  const replies = list.slice(1).map((item) => reply(map, thread.id, item))
  return {
    ...root,
    threadId: root.id,
    file: at.path,
    side: at.side === "RIGHT" ? "additions" : "deletions",
    line: at.line,
    ...(at.startLine === undefined ? {} : { startLine: at.startLine }),
    resolved: RESOLVED.has(thread.status ?? ""),
    // Azure DevOps re-anchors threads across iterations itself instead of marking them outdated.
    outdated: false,
    ...(replies.length > 0 ? { replies } : {}),
  }
}

/**
 * Azure DevOps CLI provider. Resource names and route parameters for `az devops invoke` were checked
 * against the organization's live resource-location list (area `git`: `pullRequests`,
 * `pullRequestThreads`, `pullRequestThreadComments`, `pullRequestCommentLikes`, `pullRequestStatuses`).
 *
 * Forked PRs are imported from the fork's own remote (`forkSource.repository.remoteUrl`).
 */
export class AzureDevOpsProvider implements Provider {
  readonly id = "azuredevops" as const
  readonly cliBin = AZ
  readonly labels = {
    service: "Azure DevOps",
    tool: "Azure CLI (az) with the azure-devops extension",
    login: "az login",
  }
  readonly authHint = "Run 'az login', then 'az extension add --name azure-devops' if not already installed"
  readonly missingHint = "Azure CLI (az) is not installed. Install it from https://learn.microsoft.com/cli/azure/"
  private viewerRequest: Promise<string | undefined> | undefined

  detectHost(remoteUrl: string): boolean {
    return /dev\.azure\.com|visualstudio\.com/i.test(remoteUrl)
  }

  parsePrUrl(url: string): PrRef | null {
    let normalized = url.trim()
    if (!normalized.startsWith("http")) normalized = `https://${normalized}`
    normalized = normalized.replace(/\/+$/, "")
    const modern = normalized.match(/^https?:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)/)
    const legacy =
      modern ?? normalized.match(/^https?:\/\/([^./]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)/)
    if (!legacy) return null
    const [, org, project, repo, number] = legacy
    return {
      host: "dev.azure.com",
      owner: org!,
      project: decodeURIComponent(project!),
      repo: decodeURIComponent(repo!),
      number: parseInt(number!, 10),
    }
  }

  parseRemote(remoteUrl: string): Omit<PrRef, "number"> | null {
    const trimmed = remoteUrl.trim()
    // SSH form has no `_git` segment: git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
    const ssh = trimmed.match(/ssh\.dev\.azure\.com[:/]+v\d+\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/)
    const modern = ssh ?? trimmed.match(/(?<!ssh\.)dev\.azure\.com[:/]+([^/]+)\/([^/]+)\/_git\/([^/]+?)(?:\.git)?\/?$/)
    const legacy =
      modern ??
      trimmed.match(/([^./@]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/]+?)(?:\.git)?\/?$/)
    if (!legacy) return null
    return {
      host: "dev.azure.com",
      owner: legacy[1]!,
      project: decodeURIComponent(legacy[2]!),
      repo: decodeURIComponent(legacy[3]!),
    }
  }

  classifyCliError(msg: string): CliErrorKind {
    if (msg.includes("command not found") || msg.includes("ENOENT") || msg.includes("is not recognized"))
      return "cli_missing"
    if (msg.includes("azure-devops") && msg.includes("extension")) return "cli_missing"
    if (msg.includes("az login") || msg.includes("Please run 'az login'") || msg.includes("AADSTS")) return "cli_auth"
    if (msg.includes("does not exist") || msg.includes("not found") || msg.includes("TF401180")) return "not_found"
    return "unknown"
  }

  pullRef(ref: PrRef): string {
    return `refs/pull/${ref.number}/merge`
  }

  private org(owner: string): string {
    return `https://dev.azure.com/${owner}`
  }

  private route(ref: PrRef): Record<string, string> {
    return { project: ref.project ?? ref.repo, repositoryId: ref.repo, pullRequestId: String(ref.number) }
  }

  private async cli(root: string, args: string[], timeout = 20_000): Promise<unknown> {
    const { stdout } = await execCliRead(this.cliBin, [...args, "-o", "json"], {
      cwd: root,
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    })
    return stdout.trim() ? JSON.parse(stdout) : undefined
  }

  /** `az devops invoke` in area `git` — the REST escape hatch for endpoints with no `az repos pr` subcommand. */
  private async invoke(
    root: string,
    owner: string,
    resource: string,
    route: Record<string, string>,
    opts: { method?: "POST" | "PATCH" | "DELETE"; body?: unknown } = {},
  ): Promise<unknown> {
    const args = [
      "devops",
      "invoke",
      "--area",
      "git",
      "--resource",
      resource,
      "--route-parameters",
      ...Object.entries(route).map(([key, value]) => `${key}=${value}`),
      "--api-version",
      API,
      "--organization",
      this.org(owner),
    ]
    if (opts.method) args.push("--http-method", opts.method)
    if (opts.body === undefined) return this.cli(root, args)
    const dir = await mkdtemp(join(tmpdir(), "kilo-az-"))
    try {
      const file = join(dir, "body.json")
      await writeFile(file, JSON.stringify(opts.body), { encoding: "utf8", mode: 0o600 })
      return await this.cli(root, [...args, "--in-file", file])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  private async pr(ref: PrRef, root: string): Promise<AzPr> {
    return (await this.cli(root, [
      "repos",
      "pr",
      "show",
      "--id",
      String(ref.number),
      "--organization",
      this.org(ref.owner),
    ])) as AzPr
  }

  private viewer(root: string): Promise<string | undefined> {
    this.viewerRequest ??= this.cli(root, ["account", "show", "--query", "user.name"]).then(
      (value) => (typeof value === "string" ? value : undefined),
      () => {
        this.viewerRequest = undefined
        return undefined
      },
    )
    return this.viewerRequest
  }

  private webUrl(ref: PrRef, pr?: AzPr): string {
    const repo = pr?.repository?.webUrl
    if (repo) return `${repo}/pullrequest/${ref.number}`
    const project = encodeURIComponent(ref.project ?? ref.repo)
    return `${this.org(ref.owner)}/${project}/_git/${encodeURIComponent(ref.repo)}/pullrequest/${ref.number}`
  }

  async fetchPrInfo(ref: PrRef, root: string): Promise<ProviderPrInfo> {
    const pr = await this.pr(ref, root)
    const fork = pr.forkSource?.repository
    const info = {
      headRefName: stripHeads(pr.forkSource?.name ?? pr.sourceRefName),
      baseRefName: stripHeads(pr.targetRefName),
      title: pr.title,
    }
    if (!fork?.remoteUrl) return { ...info, isCrossRepository: false }
    return { ...info, isCrossRepository: true, forkOwnerKey: forkKey(fork), forkRemoteUrl: fork.remoteUrl }
  }

  async fetchStatus(ref: PrRef, root: string): Promise<ProviderPrStatus> {
    const [pr, policies, statuses, viewer] = await Promise.all([
      this.pr(ref, root),
      this.cli(root, [
        "repos",
        "pr",
        "policy",
        "list",
        "--id",
        String(ref.number),
        "--organization",
        this.org(ref.owner),
      ])
        .then((value) => (Array.isArray(value) ? (value as AzPolicy[]) : []))
        .catch(() => [] as AzPolicy[]),
      this.invoke(root, ref.owner, "pullRequestStatuses", this.route(ref))
        .then((value) => ((value as { value?: AzStatus[] } | undefined)?.value ?? []) as AzStatus[])
        .catch(() => [] as AzStatus[]),
      this.viewer(root),
    ])
    const reviewers = (pr.reviewers ?? [])
      .filter((item) => item.uniqueName || item.displayName)
      .map((item) => ({ login: item.uniqueName ?? item.displayName ?? "unknown", state: vote(item.vote) }))
    return {
      title: pr.title,
      body: pr.description ?? "",
      url: this.webUrl(ref, pr),
      state: state(pr),
      author: pr.createdBy?.uniqueName ?? pr.createdBy?.displayName,
      viewerDidAuthor: same(pr.createdBy?.uniqueName, viewer),
      createdAt: pr.creationDate,
      baseRefOid: pr.lastMergeTargetCommit?.commitId,
      headRefOid: pr.lastMergeSourceCommit?.commitId,
      checks: this.checks(ref, policies, statuses),
      reviewers,
      merge: this.merge(pr, policies),
    }
  }

  /** Branch-policy evaluations (build validation, reviewer and comment requirements) plus PR statuses. */
  private checks(ref: PrRef, policies: AzPolicy[], statuses: AzStatus[]): ProviderPrStatus["checks"] {
    const project = encodeURIComponent(ref.project ?? ref.repo)
    const fromPolicies: PRCheck[] = policies
      .filter((item) => item.configuration?.isEnabled !== false && item.status !== "notApplicable")
      .map((item) => {
        const build = item.context?.buildId
        return {
          name: item.configuration?.settings?.displayName ?? item.configuration?.type?.displayName ?? "Policy",
          status: policyStatus(item.status),
          ...(build ? { url: `${this.org(ref.owner)}/${project}/_build/results?buildId=${build}` } : {}),
          duration: formatCheckDuration(item.startedDate, item.completedDate),
        }
      })
    // Statuses are posted per iteration; keep the newest one for each context.
    const latest = new Map<string, AzStatus>()
    for (const item of [...statuses].sort((a, b) => (a.id ?? 0) - (b.id ?? 0))) {
      const key = [item.context?.genre, item.context?.name].filter(Boolean).join("/")
      if (key) latest.set(key, item)
    }
    const fromStatuses: PRCheck[] = [...latest].map(([name, item]) => ({
      name,
      status: statusState(item.state),
      ...(item.targetUrl ? { url: item.targetUrl } : {}),
    }))
    return summarize([...fromPolicies, ...fromStatuses])
  }

  private merge(pr: AzPr, policies: AzPolicy[]): ProviderMerge {
    const strategy = policies.find((item) => item.configuration?.type?.displayName === "Require a merge strategy")
    const settings = strategy?.configuration?.settings
    const methods: PRMergeMethod[] = settings
      ? [
          ...(settings.allowSquash === true ? (["squash"] as const) : []),
          ...(settings.allowNoFastForward === true ? (["merge"] as const) : []),
          ...(settings.allowRebase === true || settings.allowRebaseMerge === true ? (["rebase"] as const) : []),
        ]
      : ["squash", "merge", "rebase"]
    const blocked = policies.some(
      (item) =>
        item.configuration?.isBlocking === true &&
        item.configuration.isEnabled !== false &&
        item.status !== "approved" &&
        item.status !== "notApplicable",
    )
    const conflicting = pr.mergeStatus === "conflicts"
    const ready = pr.mergeStatus === "succeeded"
    const merged: PRMergeState = pr.isDraft
      ? "draft"
      : conflicting
        ? "dirty"
        : blocked || pr.mergeStatus === "rejectedByPolicy"
          ? "blocked"
          : ready
            ? "clean"
            : "unknown"
    return {
      mergeable: conflicting ? "conflicting" : ready ? "mergeable" : "unknown",
      state: merged,
      auto: pr.autoCompleteSetBy
        ? method(pr.completionOptions?.mergeStrategy, pr.completionOptions?.squashMerge)
        : null,
      methods: methods.length > 0 ? methods : ["squash", "merge", "rebase"],
      autoAllowed: true,
      canWrite: true,
    }
  }

  async fetchThreads(ref: PrRef, root: string): Promise<ProviderThreads> {
    const list = <T>(resource: string) =>
      this.invoke(root, ref.owner, resource, this.route(ref)).then(
        (value) => ((value as { value?: T[] } | undefined)?.value ?? []) as T[],
        () => [] as T[],
      )
    const [data, viewer, pr, commits, iterations] = await Promise.all([
      this.invoke(root, ref.owner, "pullRequestThreads", this.route(ref)) as Promise<
        { value?: AzThread[] } | undefined
      >,
      this.viewer(root),
      this.pr(ref, root),
      list<AzCommit>("pullRequestCommits"),
      list<AzIteration>("pullRequestIterations"),
    ])
    const project = ref.project ?? ref.repo
    const web = this.webUrl(ref, pr)
    const map: Mapping = {
      id: (thread, comment) => encodeThreadId("azuredevops", ref.owner, project, ref.repo, ref.number, thread, comment),
      viewer,
      url: (thread) => `${web}?discussionId=${thread}`,
    }
    const threads = data?.value ?? []
    const comments: PRComment[] = []
    const conversation: PRTimelineItem[] = []
    for (const thread of threads) {
      if (thread.isDeleted) continue
      const visible = (thread.comments ?? []).filter((item) => !item.isDeleted && item.commentType !== "system")
      const comment = review(map, thread, visible)
      if (comment) comments.push(comment)
      if (!comment) conversation.push(...visible.map((item) => issue(map, thread.id, item)))
    }
    const target = stripHeads(pr.targetRefName)
    const status = statusEvents(threads, target)
    // Fork commits live in the fork, so link them there.
    const repo = pr.forkSource?.repository?.webUrl ?? pr.repository?.webUrl
    conversation.push(
      ...commitItems(commits, repo),
      ...status,
      ...closure(pr, target, status),
      ...pushEvents(iterations),
    )
    return { comments, conversation: conversation.sort(byTime) }
  }

  async findOpenByBranch(base: Omit<PrRef, "number">, branch: string, root: string): Promise<PrRef | null> {
    const list = (await this.cli(root, [
      "repos",
      "pr",
      "list",
      "--source-branch",
      branch,
      "--status",
      "active",
      "--organization",
      this.org(base.owner),
      "--project",
      base.project ?? base.repo,
      "--repository",
      base.repo,
    ])) as Array<{ pullRequestId: number }>
    const first = list.at(0)
    return first ? { ...base, number: first.pullRequestId } : null
  }

  async fetchDiffRefs(ref: PrRef, root: string): Promise<{ baseRefOid: string; headRefOid: string }> {
    const pr = await this.pr(ref, root)
    const baseRefOid = pr.lastMergeTargetCommit?.commitId
    const headRefOid = pr.lastMergeSourceCommit?.commitId
    if (!baseRefOid || !headRefOid) throw new Error("Azure DevOps did not return pull request diff revisions.")
    return { baseRefOid, headRefOid }
  }

  async postComment(ref: PrRef, input: ProviderCommentInput, root: string): Promise<{ id: string }> {
    const end = { line: input.line, offset: 1 }
    const start = { line: input.startLine ?? input.line, offset: 1 }
    const threadContext =
      input.side === "RIGHT"
        ? { filePath: `/${input.path}`, rightFileStart: start, rightFileEnd: end }
        : { filePath: `/${input.path}`, leftFileStart: start, leftFileEnd: end }
    const data = (await this.invoke(root, ref.owner, "pullRequestThreads", this.route(ref), {
      method: "POST",
      body: {
        comments: [{ parentCommentId: 0, content: input.body, commentType: "text" }],
        status: "active",
        threadContext,
      },
    })) as { id?: number; comments?: Array<{ id: number }> } | undefined
    const comment = data?.comments?.at(0)?.id
    if (data?.id === undefined || comment === undefined)
      throw new Error("Azure DevOps did not confirm the review comment.")
    return {
      id: encodeThreadId("azuredevops", ref.owner, ref.project ?? ref.repo, ref.repo, ref.number, data.id, comment),
    }
  }

  async postGeneralComment(ref: PrRef, body: string, root: string): Promise<void> {
    await this.invoke(root, ref.owner, "pullRequestThreads", this.route(ref), {
      method: "POST",
      body: { comments: [{ parentCommentId: 0, content: body, commentType: "text" }], status: "active" },
    })
  }

  /** Casts the caller's real vote; "request changes" maps to "wait for author", Azure DevOps's non-final block. */
  async submitReview(ref: PrRef, event: ProviderReviewEvent, body: string, _head: string, root: string): Promise<void> {
    if (event !== "comment") {
      await this.cli(root, [
        "repos",
        "pr",
        "set-vote",
        "--id",
        String(ref.number),
        "--vote",
        event === "approve" ? "approve" : "wait-for-author",
        "--organization",
        this.org(ref.owner),
      ])
    }
    if (body.trim()) await this.postGeneralComment(ref, body, root)
  }

  private decode(id: string) {
    const decoded = decodeThreadId(id)
    if (!decoded || decoded.providerId !== "azuredevops" || decoded.parts.length !== 6)
      throw new Error("Invalid Azure DevOps comment id.")
    const [owner, project, repo, number, thread, comment] = decoded.parts as [
      string,
      string,
      string,
      string,
      string,
      string,
    ]
    const ref: PrRef = { host: "dev.azure.com", owner, project, repo, number: Number(number) }
    return { ref, thread, comment }
  }

  async replyThread(threadId: string, body: string, root: string): Promise<void> {
    const { ref, thread } = this.decode(threadId)
    await this.invoke(
      root,
      ref.owner,
      "pullRequestThreadComments",
      { ...this.route(ref), threadId: thread },
      { method: "POST", body: { content: body, commentType: "text", parentCommentId: 1 } },
    )
  }

  async resolveThread(threadId: string, resolved: boolean, root: string): Promise<void> {
    const { ref, thread } = this.decode(threadId)
    await this.invoke(
      root,
      ref.owner,
      "pullRequestThreads",
      { ...this.route(ref), threadId: thread },
      { method: "PATCH", body: { status: resolved ? "fixed" : "active" } },
    )
  }

  async editComment(commentId: string, body: string, root: string): Promise<void> {
    const { ref, thread, comment } = this.decode(commentId)
    await this.invoke(
      root,
      ref.owner,
      "pullRequestThreadComments",
      { ...this.route(ref), threadId: thread, commentId: comment },
      { method: "PATCH", body: { content: body } },
    )
  }

  async deleteComment(commentId: string, root: string): Promise<void> {
    const { ref, thread, comment } = this.decode(commentId)
    await this.invoke(
      root,
      ref.owner,
      "pullRequestThreadComments",
      { ...this.route(ref), threadId: thread, commentId: comment },
      { method: "DELETE" },
    )
  }

  async fetchSuggestionSource(commentId: string, root: string): Promise<SuggestionSource> {
    const { ref, thread, comment } = this.decode(commentId)
    const [data, pr] = await Promise.all([
      this.invoke(root, ref.owner, "pullRequestThreads", { ...this.route(ref), threadId: thread }) as Promise<
        AzThread | undefined
      >,
      this.pr(ref, root),
    ])
    const target = data?.comments?.find((item) => String(item.id) === comment)
    const at = place(data?.threadContext)
    const head = pr.lastMergeSourceCommit?.commitId
    if (!target?.content || !at || !head) throw new Error("Azure DevOps suggestion could not be verified.")
    return {
      path: at.path,
      side: at.side,
      line: at.line,
      ...(at.startLine === undefined ? {} : { startLine: at.startLine }),
      outdated: false,
      headRefOid: head,
      body: target.content,
    }
  }

  async react(commentId: string, content: PRReactionContent, add: boolean, root: string): Promise<void> {
    if (content !== "THUMBS_UP") throw new Error("Azure DevOps only supports liking a comment.")
    const { ref, thread, comment } = this.decode(commentId)
    await this.invoke(
      root,
      ref.owner,
      "pullRequestCommentLikes",
      { ...this.route(ref), threadId: thread, commentId: comment },
      { method: add ? "POST" : "DELETE" },
    )
  }

  /**
   * Completes the PR with the chosen strategy. `lastMergeSourceCommit` is Azure DevOps's own guard:
   * completion fails if the source branch moved since the commit the reviewer saw.
   */
  async mergePr(ref: PrRef, method: PRMergeMethod, auto: boolean, headRefOid: string, root: string): Promise<void> {
    const pr = await this.pr(ref, root)
    if (pr.lastMergeSourceCommit?.commitId !== headRefOid)
      throw new Error("Pull request changed. Refresh and try again.")
    const completionOptions = { ...(pr.completionOptions ?? {}), mergeStrategy: STRATEGY[method] }
    if (auto) {
      // Setting auto-complete needs the caller's identity, which the CLI resolves for us.
      await this.cli(root, [
        "repos",
        "pr",
        "update",
        "--id",
        String(ref.number),
        "--auto-complete",
        "true",
        "--organization",
        this.org(ref.owner),
      ])
      await this.invoke(root, ref.owner, "pullRequests", this.route(ref), {
        method: "PATCH",
        body: { completionOptions },
      })
      return
    }
    await this.invoke(root, ref.owner, "pullRequests", this.route(ref), {
      method: "PATCH",
      body: { status: "completed", lastMergeSourceCommit: { commitId: headRefOid }, completionOptions },
    })
  }

  /**
   * No Azure DevOps endpoint updates a PR branch from its base in one call, so this merges the base
   * locally and pushes. It runs in the PR's own worktree and refuses if that isn't on the PR branch.
   */
  async updateBranchFromBase(ref: PrRef, root: string): Promise<void> {
    const pr = await this.pr(ref, root)
    const head = stripHeads(pr.forkSource?.name ?? pr.sourceRefName)
    const base = stripHeads(pr.targetRefName)
    const git = (args: string[]) => execWithShellEnv("git", args, { cwd: root, timeout: 60_000 })
    const config = (key: string) =>
      git(["config", "--get", key]).then(
        (result) => result.stdout.trim(),
        () => "",
      )
    const current = (await git(["symbolic-ref", "--short", "HEAD"])).stdout.trim()
    // A fork PR's branch is checked out as `<fork>/<branch>` and tracks the fork's remote.
    const remote = (await config(`branch.${current}.remote`)) || "origin"
    const merge = stripHeads(await config(`branch.${current}.merge`))
    if ((merge || current) !== head)
      throw new Error(`Worktree is on "${current}", not the pull request branch "${head}".`)
    await git(["fetch", "origin", base])
    await git(["fetch", remote, head])
    await git(["merge", "--no-edit", `origin/${base}`])
    await git(["push", remote, `HEAD:${head}`])
  }

  async disableAutoMerge(ref: PrRef, root: string): Promise<void> {
    await this.cli(root, [
      "repos",
      "pr",
      "update",
      "--id",
      String(ref.number),
      "--auto-complete",
      "false",
      "--organization",
      this.org(ref.owner),
    ])
  }
}
