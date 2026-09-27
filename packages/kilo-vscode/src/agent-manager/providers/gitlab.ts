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
  PRReaction,
  PRReactionContent,
  PRReviewer,
  PRTimelineItem,
} from "../types"
import { formatCheckDuration, summarize } from "../pr/am-pr-utils"
import {
  bounded,
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

const GLAB = "glab"

/** GitHub's reaction enum -> GitLab's award-emoji name. GitLab has no equivalent for CONFUSED. */
const EMOJI: Partial<Record<PRReactionContent, string>> = {
  THUMBS_UP: "thumbsup",
  THUMBS_DOWN: "thumbsdown",
  LAUGH: "laughing",
  HOORAY: "tada",
  HEART: "heart",
  ROCKET: "rocket",
  EYES: "eyes",
}
const CONTENT = new Map(Object.entries(EMOJI).map(([content, name]) => [name, content as PRReactionContent]))

const PAGE = 100
const PAGES = 20
const REBASE_POLL = 1_000
const REBASE_TIMEOUT = 60_000

interface GlabMr {
  iid: number
  source_branch: string
  target_branch: string
  title: string
  description?: string | null
  source_project_id: number
  target_project_id: number
  web_url: string
  state: string
  draft?: boolean
  author?: { username?: string }
  created_at?: string
  sha?: string
  diff_refs?: { base_sha?: string; head_sha?: string; start_sha?: string } | null
  detailed_merge_status?: string
  has_conflicts?: boolean
  merge_when_pipeline_succeeds?: boolean
  squash?: boolean
  user?: { can_merge?: boolean }
  rebase_in_progress?: boolean
  merge_error?: string | null
  merged_at?: string | null
  merged_by?: GlabUser | null
  closed_at?: string | null
  closed_by?: GlabUser | null
}

interface GlabCommit {
  id: string
  short_id?: string
  title?: string
  author_name?: string
  committed_date?: string
  web_url?: string
}

interface GlabStateEvent {
  id: number
  user?: GlabUser | null
  created_at?: string
  state?: string
}

interface GlabProject {
  path_with_namespace: string
  http_url_to_repo: string
  squash_option?: "never" | "always" | "default_on" | "default_off"
}

interface GlabUser {
  username?: string
  avatar_url?: string
}

interface GlabNote {
  id: number
  body?: string
  author?: GlabUser
  created_at?: string
  system?: boolean
  resolvable?: boolean
  resolved?: boolean
  position?: {
    new_path?: string | null
    old_path?: string | null
    new_line?: number | null
    old_line?: number | null
    head_sha?: string | null
    line_range?: {
      start?: { new_line?: number | null; old_line?: number | null }
    } | null
  } | null
}

interface GlabAward {
  id?: number
  name?: string
  user?: GlabUser | null
}

/**
 * Every note's award emoji in one request per 100 notes (`Note.awardEmoji`, GitLab 16+). REST has no
 * bulk endpoint, only one request per note, so it is used as a fallback only.
 */
const AWARDS_QUERY = `query($path: ID!, $iid: String!, $after: String) {
  project(fullPath: $path) {
    mergeRequest(iid: $iid) {
      notes(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id awardEmoji(first: 100) { pageInfo { hasNextPage } nodes { name user { username } } } }
      }
    }
  }
}`

interface GlabAwardPage {
  errors?: Array<{ message?: string }>
  data?: {
    project?: {
      mergeRequest?: {
        notes?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
          nodes?: Array<{
            id?: string
            awardEmoji?: { pageInfo?: { hasNextPage?: boolean }; nodes?: GlabAward[] } | null
          } | null>
        }
      } | null
    } | null
  }
}

/** Termination bound for page loops only: 100,000 notes or reactions, far beyond any real MR. */
const LOOP = 1_000

interface GlabDiscussion {
  id: string
  notes?: GlabNote[]
}

interface GlabJob {
  name: string
  status: string
  allow_failure?: boolean
  web_url?: string
  started_at?: string | null
  finished_at?: string | null
}

function state(mr: Pick<GlabMr, "state" | "draft">): ProviderPrStatus["state"] {
  if (mr.state === "merged") return "merged"
  if (mr.state === "closed") return "closed"
  if (mr.draft) return "draft"
  return "open"
}

const BLOCKED = new Set([
  "ci_must_pass",
  "ci_still_running",
  "not_approved",
  "discussions_not_resolved",
  "requested_changes",
  "blocked_status",
  "external_status_checks",
  "jira_association_missing",
  "security_policy_violations",
  "merge_request_blocked",
  "locked_paths",
  "locked_lfs_files",
  "title_regex",
])

function mergeState(status: string | undefined): PRMergeState {
  if (status === "mergeable") return "clean"
  if (status === "conflict") return "dirty"
  if (status === "need_rebase") return "behind"
  if (status === "draft_status") return "draft"
  if (status && BLOCKED.has(status)) return "blocked"
  return "unknown"
}

function jobStatus(job: GlabJob): CheckStatus {
  if (job.status === "success") return "success"
  if (job.status === "failed") return job.allow_failure ? "skipped" : "failure"
  if (job.status === "canceled" || job.status === "canceling") return "cancelled"
  if (job.status === "skipped" || job.status === "manual") return "skipped"
  return "pending"
}

function pipelineStatus(status: string): CheckStatus {
  return jobStatus({ name: "", status })
}

function reviewerState(value: string | undefined): PRReviewer["state"] {
  if (value === "approved") return "approved"
  if (value === "requested_changes") return "changes_requested"
  if (value === "reviewed") return "commented"
  return "pending"
}

function time(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : undefined
}

/** GraphQL note ids look like `gid://gitlab/Note/123` or `gid://gitlab/DiffNote/123`; REST uses 123. */
function noteId(gid: string | undefined): number | undefined {
  const match = gid ? /\/(\d+)$/.exec(gid) : null
  return match ? Number(match[1]) : undefined
}

function reactions(list: GlabAward[], viewer: string | undefined): PRReaction[] | undefined {
  const counts = new Map<PRReactionContent, PRReaction>()
  for (const award of list) {
    const content = award.name ? CONTENT.get(award.name) : undefined
    if (!content) continue
    const entry = counts.get(content) ?? { content, count: 0, viewerHasReacted: false }
    entry.count++
    if (viewer && award.user?.username === viewer) entry.viewerHasReacted = true
    counts.set(content, entry)
  }
  return counts.size > 0 ? [...counts.values()] : undefined
}

/** Records one GraphQL notes page into `awards`/`more`; returns the next cursor, if any. */
function collect(data: GlabAwardPage | undefined, awards: Map<number, GlabAward[]>, more: number[]) {
  if (data?.errors?.length) throw new Error(data.errors.map((item) => item.message).join("; "))
  const notes = data?.data?.project?.mergeRequest?.notes
  if (!notes) throw new Error("GitLab returned no merge request notes.")
  for (const node of notes.nodes ?? []) record(node, awards, more)
  return notes.pageInfo?.hasNextPage ? (notes.pageInfo.endCursor ?? undefined) : undefined
}

type GlabAwardNode = NonNullable<
  NonNullable<NonNullable<NonNullable<GlabAwardPage["data"]>["project"]>["mergeRequest"]>["notes"]
>["nodes"]

function record(node: NonNullable<GlabAwardNode>[number], awards: Map<number, GlabAward[]>, more: number[]) {
  const id = noteId(node?.id)
  if (id === undefined) return
  awards.set(id, node?.awardEmoji?.nodes ?? [])
  if (node?.awardEmoji?.pageInfo?.hasNextPage) more.push(id)
}

function byTime(a: PRTimelineItem, b: PRTimelineItem): number {
  return (a.createdAt ?? 0) - (b.createdAt ?? 0)
}

function commitItem(commit: GlabCommit): PRCommitItem {
  return {
    kind: "commit",
    id: `commit:${commit.id}`,
    sha: commit.id,
    short: commit.short_id ?? commit.id.slice(0, 7),
    message: commit.title ?? "",
    author: commit.author_name ?? "unknown",
    createdAt: time(commit.committed_date),
    ...(commit.web_url ? { url: commit.web_url } : {}),
  }
}

const STATE: Record<string, PREventKind> = { merged: "merged", closed: "closed", reopened: "reopened" }

function stateEvent(item: GlabStateEvent, target: string): PREventItem | undefined {
  const event = item.state ? STATE[item.state] : undefined
  if (!event) return undefined
  return {
    kind: "event",
    event,
    id: `state:${item.id}`,
    actor: item.user?.username ?? "unknown",
    avatar: item.user?.avatar_url,
    createdAt: time(item.created_at),
    ...(event === "merged" ? { detail: target } : {}),
  }
}

/** The MR's own merged/closed fields, for MRs older than resource state events. */
function closure(mr: GlabMr, events: PREventItem[]): PREventItem[] {
  const merged = mr.state === "merged"
  const event: PREventKind | undefined = merged ? "merged" : mr.state === "closed" ? "closed" : undefined
  if (!event || events.some((item) => item.event === event)) return []
  const user = merged ? mr.merged_by : mr.closed_by
  const item: PREventItem = {
    kind: "event",
    event,
    id: `closed:${mr.iid}`,
    actor: user?.username ?? "unknown",
    avatar: user?.avatar_url,
    createdAt: time((merged ? mr.merged_at : mr.closed_at) ?? undefined),
    ...(merged ? { detail: mr.target_branch } : {}),
  }
  return [item]
}

/** Where a diff note sits, or `undefined` for a note that isn't anchored to a diff line. */
function place(position: GlabNote["position"]) {
  if (!position) return undefined
  const right = position.new_line != null
  const line = right ? position.new_line : position.old_line
  if (line == null) return undefined
  const start = right ? position.line_range?.start?.new_line : position.line_range?.start?.old_line
  const path = right ? position.new_path : position.old_path
  return {
    path: path ?? position.new_path ?? undefined,
    side: right ? ("RIGHT" as const) : ("LEFT" as const),
    line,
    startLine: start != null && start !== line ? start : undefined,
    head: position.head_sha ?? undefined,
  }
}

interface Mapping {
  id: (discussion: string, note: number) => string
  viewer: string | undefined
  web: string
  awards: Map<number, PRReaction[]>
}

function reply(map: Mapping, discussion: string, note: GlabNote): PRCommentReply & { id: string } {
  const own = !!map.viewer && note.author?.username === map.viewer
  return {
    id: map.id(discussion, note.id),
    canEdit: own,
    canDelete: own,
    author: note.author?.username ?? "unknown",
    body: note.body ?? "",
    avatar: note.author?.avatar_url,
    createdAt: time(note.created_at),
    url: `${map.web}#note_${note.id}`,
    reactions: map.awards.get(note.id),
  }
}

function issue(map: Mapping, discussion: string, note: GlabNote): PRConversationComment {
  return { kind: "issue", ...reply(map, discussion, note) }
}

/** A diff discussion as a review thread; `undefined` when its first note isn't on a diff line. */
function thread(map: Mapping, discussion: string, list: GlabNote[], head: string | undefined): PRComment | undefined {
  const first = list.at(0)
  const at = place(first?.position)
  if (!first || !at) return undefined
  const root = reply(map, discussion, first)
  const replies = list.slice(1).map((note) => reply(map, discussion, note))
  const resolvable = list.filter((note) => note.resolvable)
  return {
    ...root,
    threadId: root.id,
    file: at.path,
    side: at.side === "RIGHT" ? "additions" : "deletions",
    line: at.line,
    ...(at.startLine === undefined ? {} : { startLine: at.startLine }),
    resolved: resolvable.length > 0 && resolvable.every((note) => note.resolved),
    // A note made against an older MR version no longer maps onto the current diff.
    outdated: !!head && !!at.head && at.head !== head,
    ...(replies.length > 0 ? { replies } : {}),
  }
}

export class GitLabProvider implements Provider {
  readonly id = "gitlab" as const
  readonly cliBin = GLAB
  readonly labels = { service: "GitLab", tool: "GitLab CLI (glab)", login: "glab auth login" }
  readonly authHint = "Run 'glab auth login'"
  readonly missingHint = "GitLab CLI (glab) is not installed. Install it from https://gitlab.com/gitlab-org/cli"
  private readonly viewers = new Map<string, Promise<string | undefined>>()

  detectHost(remoteUrl: string): boolean {
    return /gitlab/i.test(remoteUrl)
  }

  parsePrUrl(url: string): PrRef | null {
    let normalized = url.trim()
    if (!normalized.startsWith("http")) normalized = `https://${normalized}`
    normalized = normalized.replace(/\/+$/, "")
    // The `/-/merge_requests/` path is GitLab's own, so self-managed hosts on any domain match.
    const match = normalized.match(/^https?:\/\/([^/]+)\/(.+)\/-\/merge_requests\/(\d+)/)
    if (!match) return null
    const host = match[1]!
    const path = match[2]!
    const number = parseInt(match[3]!, 10)
    const segments = path.split("/")
    const repo = segments.pop()
    if (!repo || segments.length === 0) return null
    return { host, owner: segments.join("/"), repo, number }
  }

  /** `any` skips the hostname check, for a host already confirmed as GitLab via {@link signedIn}. */
  parseRemote(remoteUrl: string, any = false): Omit<PrRef, "number"> | null {
    const trimmed = remoteUrl.trim()
    if (!any && !/gitlab/i.test(trimmed)) return null
    const ssh = trimmed.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?\/?$/)
    const https = trimmed.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/)
    const match = ssh ?? https
    if (!match) return null
    const segments = match[2]!.split("/")
    const repo = segments.pop()
    if (!repo || segments.length === 0) return null
    return { host: match[1]!, owner: segments.join("/"), repo }
  }

  /**
   * Whether `glab` is signed in to this host. A remote URL alone can't tell a custom-domain GitLab
   * from GitHub Enterprise; being authenticated there with glab is what identifies it.
   */
  signedIn(host: string, root: string): Promise<boolean> {
    return execCliRead(this.cliBin, ["auth", "status", "--hostname", host], { cwd: root, timeout: 5_000 }).then(
      () => true,
      () => false,
    )
  }

  classifyCliError(msg: string): CliErrorKind {
    if (msg.includes("command not found") || msg.includes("ENOENT") || msg.includes("is not recognized"))
      return "cli_missing"
    if (msg.includes("not logged") || msg.includes("auth login") || msg.includes("401 ")) return "cli_auth"
    if (msg.includes("404 ") || msg.includes("not found") || msg.includes("Could not resolve")) return "not_found"
    return "unknown"
  }

  pullRef(ref: PrRef): string {
    return `refs/merge-requests/${ref.number}/head`
  }

  /** `glab api` against the MR's own host, so self-managed instances work from any cwd. */
  private async api(
    host: string,
    root: string,
    path: string,
    opts: {
      method?: "POST" | "PUT" | "DELETE"
      raw?: Record<string, string>
      typed?: Record<string, string | number | boolean>
    } = {},
    timeout = 15_000,
  ): Promise<unknown> {
    const args = ["api", "--hostname", host, path]
    if (opts.method) args.push("--method", opts.method)
    for (const [key, value] of Object.entries(opts.raw ?? {})) args.push("-f", `${key}=${value}`)
    for (const [key, value] of Object.entries(opts.typed ?? {})) args.push("-F", `${key}=${value}`)
    const { stdout } = await execCliRead(this.cliBin, args, { cwd: root, timeout, maxBuffer: 16 * 1024 * 1024 })
    return stdout.trim() ? JSON.parse(stdout) : undefined
  }

  private base(ref: Pick<PrRef, "owner" | "repo" | "number">): string {
    return `projects/${encodeURIComponent(`${ref.owner}/${ref.repo}`)}/merge_requests/${ref.number}`
  }

  private async mr(ref: PrRef, root: string, extra = ""): Promise<GlabMr> {
    return (await this.api(ref.host, root, `${this.base(ref)}${extra}`)) as GlabMr
  }

  private viewer(host: string, root: string): Promise<string | undefined> {
    const cached = this.viewers.get(host)
    if (cached) return cached
    const request = this.api(host, root, "user").then(
      (data) => (data as GlabUser | undefined)?.username,
      () => {
        this.viewers.delete(host)
        return undefined
      },
    )
    this.viewers.set(host, request)
    return request
  }

  async fetchPrInfo(ref: PrRef, root: string): Promise<ProviderPrInfo> {
    const mr = await this.mr(ref, root)
    if (mr.source_project_id === mr.target_project_id) {
      return { headRefName: mr.source_branch, baseRefName: mr.target_branch, isCrossRepository: false, title: mr.title }
    }
    const source = (await this.api(ref.host, root, `projects/${mr.source_project_id}`)) as GlabProject
    const forkOwnerKey = source.path_with_namespace.replace(/[^a-zA-Z0-9._-]/g, "-").toLowerCase()
    return {
      headRefName: mr.source_branch,
      baseRefName: mr.target_branch,
      isCrossRepository: true,
      forkOwnerKey,
      forkRemoteUrl: source.http_url_to_repo,
      title: mr.title,
    }
  }

  async fetchStatus(ref: PrRef, root: string): Promise<ProviderPrStatus> {
    const [mr, project, checks, reviewers, viewer] = await Promise.all([
      this.mr(ref, root),
      this.api(ref.host, root, `projects/${encodeURIComponent(`${ref.owner}/${ref.repo}`)}`).then(
        (data) => data as GlabProject,
        () => undefined,
      ),
      this.fetchChecks(ref, root),
      this.fetchReviewers(ref, root),
      this.viewer(ref.host, root),
    ])
    return {
      title: mr.title,
      body: mr.description ?? "",
      url: mr.web_url,
      state: state(mr),
      author: mr.author?.username,
      viewerDidAuthor: !!viewer && mr.author?.username === viewer,
      createdAt: mr.created_at,
      baseRefOid: mr.diff_refs?.base_sha,
      headRefOid: mr.diff_refs?.head_sha ?? mr.sha,
      checks,
      reviewers,
      merge: this.merge(mr, project),
    }
  }

  /**
   * GitLab's merge method (merge commit / semi-linear / fast-forward) is a project setting, not a
   * per-merge choice. "rebase" here means rebase-then-accept, which `mergePr` implements through the
   * rebase endpoint; squash availability follows the project's `squash_option`.
   */
  private merge(mr: GlabMr, project: GlabProject | undefined): ProviderMerge {
    const squash = project?.squash_option
    const methods: PRMergeMethod[] =
      squash === "always" ? ["squash"] : squash === "never" ? ["merge", "rebase"] : ["squash", "merge", "rebase"]
    const status = mr.detailed_merge_status
    const checking = status === "checking" || status === "unchecked" || status === "preparing"
    return {
      mergeable: mr.has_conflicts ? "conflicting" : checking ? "unknown" : "mergeable",
      state: mergeState(status),
      auto: mr.merge_when_pipeline_succeeds ? (mr.squash ? "squash" : "merge") : null,
      methods,
      autoAllowed: true,
      canWrite: mr.user?.can_merge ?? true,
    }
  }

  /** Jobs of the MR's latest pipeline, one check each — the same granularity GitHub's checks have. */
  private async fetchChecks(ref: PrRef, root: string): Promise<ProviderPrStatus["checks"]> {
    const pipelines = (await this.api(ref.host, root, `${this.base(ref)}/pipelines`).catch(() => [])) as Array<{
      id: number
      status: string
      web_url?: string
    }>
    const latest = pipelines.at(0)
    if (!latest) return summarize([])
    const project = encodeURIComponent(`${ref.owner}/${ref.repo}`)
    const jobs = (await this.api(
      ref.host,
      root,
      `projects/${project}/pipelines/${latest.id}/jobs?per_page=${PAGE}`,
    ).catch(() => undefined)) as GlabJob[] | undefined
    if (!jobs || jobs.length === 0)
      return summarize([{ name: "Pipeline", status: pipelineStatus(latest.status), url: latest.web_url }])
    const checks: PRCheck[] = jobs.map((job) => ({
      name: job.name,
      status: jobStatus(job),
      url: job.web_url,
      duration: formatCheckDuration(job.started_at ?? undefined, job.finished_at ?? undefined),
    }))
    return summarize(checks)
  }

  /** Reviewer states (incl. "requested changes") from the reviewers endpoint, plus approvers not listed there. */
  private async fetchReviewers(ref: PrRef, root: string): Promise<PRReviewer[]> {
    const [listed, approvals] = await Promise.all([
      this.api(ref.host, root, `${this.base(ref)}/reviewers`).catch(() => []) as Promise<
        Array<{ user?: GlabUser; state?: string }>
      >,
      this.api(ref.host, root, `${this.base(ref)}/approvals`).catch(() => undefined) as Promise<
        { approved_by?: Array<{ user?: GlabUser }> } | undefined
      >,
    ])
    const map = new Map<string, PRReviewer>()
    for (const item of listed) {
      const login = item.user?.username
      if (!login) continue
      map.set(login, { login, avatar: item.user?.avatar_url, state: reviewerState(item.state) })
    }
    for (const item of approvals?.approved_by ?? []) {
      const login = item.user?.username
      if (!login) continue
      map.set(login, { login, avatar: item.user?.avatar_url ?? map.get(login)?.avatar, state: "approved" })
    }
    return [...map.values()]
  }

  /** Every page of an MR sub-resource, up to {@link PAGES} pages. */
  private async pages<T>(ref: PrRef, root: string, resource: string): Promise<T[]> {
    const all: T[] = []
    for (let page = 1; page <= PAGES; page++) {
      const list = (await this.api(
        ref.host,
        root,
        `${this.base(ref)}/${resource}?per_page=${PAGE}&page=${page}`,
      )) as T[]
      all.push(...list)
      if (list.length < PAGE) break
    }
    return all
  }

  /** Every note's awards via GraphQL. `more` lists notes whose own award list didn't fit in one page. */
  private async graphAwards(ref: PrRef, root: string): Promise<{ awards: Map<number, GlabAward[]>; more: number[] }> {
    const awards = new Map<number, GlabAward[]>()
    const more: number[] = []
    const seen = new Set<string>()
    const cursor: { after?: string } = {}
    for (let page = 0; page < LOOP; page++) {
      const data = (await this.api(
        ref.host,
        root,
        "graphql",
        {
          method: "POST",
          raw: {
            query: AWARDS_QUERY,
            path: `${ref.owner}/${ref.repo}`,
            iid: String(ref.number),
            ...(cursor.after ? { after: cursor.after } : {}),
          },
        },
        30_000,
      )) as GlabAwardPage | undefined
      const next = collect(data, awards, more)
      if (!next || seen.has(next)) return { awards, more }
      seen.add(next)
      cursor.after = next
    }
    throw new Error("GitLab merge request notes did not finish paging.")
  }

  /** One note's awards over REST, every page (GitLab's default page size is 20). */
  private async restAwards(ref: PrRef, root: string, note: number | string): Promise<GlabAward[]> {
    const all: GlabAward[] = []
    for (let page = 1; page <= LOOP; page++) {
      const list = (await this.api(
        ref.host,
        root,
        `${this.base(ref)}/notes/${note}/award_emoji?per_page=${PAGE}&page=${page}`,
      )) as GlabAward[]
      all.push(...list)
      if (list.length < PAGE) break
    }
    return all
  }

  /**
   * Reactions for every note, with no cap. GraphQL answers all notes in one request per 100; REST is
   * used per note only for a note with 100+ reactions, or for every note on a GitLab without
   * `Note.awardEmoji`.
   */
  private async awards(ref: PrRef, root: string, notes: GlabNote[], viewer: string | undefined) {
    const graph = await this.graphAwards(ref, root).catch(() => undefined)
    const rest = graph ? graph.more : notes.map((note) => note.id)
    const lists = new Map(graph?.awards)
    const fetched = await bounded(
      rest.map((id) => () => this.restAwards(ref, root, id).catch(() => undefined)),
      6,
    )
    for (const [index, id] of rest.entries()) {
      const list = fetched[index]
      if (list) lists.set(id, list)
    }
    const result = new Map<number, PRReaction[]>()
    for (const note of notes) {
      const list = reactions(lists.get(note.id) ?? [], viewer)
      if (list) result.set(note.id, list)
    }
    return result
  }

  async fetchThreads(ref: PrRef, root: string, headRefOid: string | undefined): Promise<ProviderThreads> {
    const [discussions, viewer, mr, commits, states] = await Promise.all([
      this.pages<GlabDiscussion>(ref, root, "discussions"),
      this.viewer(ref.host, root),
      this.mr(ref, root),
      this.pages<GlabCommit>(ref, root, "commits").catch(() => []),
      this.pages<GlabStateEvent>(ref, root, "resource_state_events").catch(() => []),
    ])
    const notes = discussions.flatMap((item) => item.notes ?? []).filter((note) => !note.system)
    const map: Mapping = {
      id: (discussion, note) => encodeThreadId("gitlab", ref.host, ref.owner, ref.repo, ref.number, discussion, note),
      viewer,
      web: mr.web_url,
      awards: await this.awards(ref, root, notes, viewer),
    }
    const comments: PRComment[] = []
    const conversation: PRTimelineItem[] = []
    for (const discussion of discussions) {
      const list = (discussion.notes ?? []).filter((note) => !note.system)
      const comment = thread(map, discussion.id, list, headRefOid)
      if (comment) comments.push(comment)
      if (!comment) conversation.push(...list.map((note) => issue(map, discussion.id, note)))
    }
    const events = states.flatMap((item) => stateEvent(item, mr.target_branch) ?? [])
    conversation.push(...commits.map(commitItem), ...events, ...closure(mr, events))
    return { comments, conversation: conversation.sort(byTime) }
  }

  async findOpenByBranch(base: Omit<PrRef, "number">, branch: string, root: string): Promise<PrRef | null> {
    const project = encodeURIComponent(`${base.owner}/${base.repo}`)
    const list = (await this.api(
      base.host,
      root,
      `projects/${project}/merge_requests?source_branch=${encodeURIComponent(branch)}&state=opened`,
    )) as Array<{ iid: number }>
    const first = list.at(0)
    return first ? { ...base, number: first.iid } : null
  }

  async fetchDiffRefs(ref: PrRef, root: string): Promise<{ baseRefOid: string; headRefOid: string }> {
    const mr = await this.mr(ref, root)
    const baseRefOid = mr.diff_refs?.base_sha
    const headRefOid = mr.diff_refs?.head_sha ?? mr.sha
    if (!baseRefOid || !headRefOid) throw new Error("GitLab did not return merge request diff revisions.")
    return { baseRefOid, headRefOid }
  }

  async postComment(ref: PrRef, input: ProviderCommentInput, root: string): Promise<{ id: string }> {
    const mr = await this.mr(ref, root)
    const refs = mr.diff_refs
    if (!refs?.base_sha || !refs.head_sha || !refs.start_sha)
      throw new Error("GitLab did not return merge request diff revisions.")
    const key = input.side === "RIGHT" ? "new_line" : "old_line"
    const kind = input.side === "RIGHT" ? "new" : "old"
    const range: Record<string, string | number> =
      input.startLine !== undefined && input.startLine !== input.line
        ? {
            [`position[line_range][start][${key}]`]: input.startLine,
            [`position[line_range][start][type]`]: kind,
            [`position[line_range][end][${key}]`]: input.line,
            [`position[line_range][end][type]`]: kind,
          }
        : {}
    const data = (await this.api(
      ref.host,
      root,
      `${this.base(ref)}/discussions`,
      {
        method: "POST",
        raw: {
          body: input.body,
          "position[position_type]": "text",
          "position[base_sha]": refs.base_sha,
          "position[start_sha]": refs.start_sha,
          "position[head_sha]": refs.head_sha,
          "position[new_path]": input.path,
          "position[old_path]": input.path,
        },
        typed: { [`position[${key}]`]: input.line, ...range },
      },
      20_000,
    )) as { id?: string; notes?: Array<{ id: number }> }
    const note = data?.notes?.at(0)?.id
    if (!data?.id || note === undefined) throw new Error("GitLab did not confirm the review comment.")
    return { id: encodeThreadId("gitlab", ref.host, ref.owner, ref.repo, ref.number, data.id, note) }
  }

  async postGeneralComment(ref: PrRef, body: string, root: string): Promise<void> {
    await this.api(ref.host, root, `${this.base(ref)}/notes`, { method: "POST", raw: { body } }, 20_000)
  }

  async submitReview(
    ref: PrRef,
    event: ProviderReviewEvent,
    body: string,
    headRefOid: string,
    root: string,
  ): Promise<void> {
    if (event === "approve") {
      await this.api(ref.host, root, `${this.base(ref)}/approve`, { method: "POST", raw: { sha: headRefOid } }, 20_000)
      if (body.trim()) await this.postGeneralComment(ref, body, root)
      return
    }
    // Publishing a review sets the reviewer state ("requested_changes" / "reviewed") and adds the
    // body as the summary note, same as the "Submit review" dialog in GitLab's UI.
    await this.api(
      ref.host,
      root,
      `${this.base(ref)}/draft_notes/bulk_publish`,
      {
        method: "POST",
        raw: {
          reviewer_state: event === "request_changes" ? "requested_changes" : "reviewed",
          ...(body.trim() ? { note: body } : {}),
        },
      },
      20_000,
    )
  }

  private decode(id: string) {
    const decoded = decodeThreadId(id)
    if (!decoded || decoded.providerId !== "gitlab" || decoded.parts.length !== 6)
      throw new Error("Invalid GitLab comment id.")
    const [host, owner, repo, number, discussion, note] = decoded.parts as [
      string,
      string,
      string,
      string,
      string,
      string,
    ]
    return { ref: { host, owner, repo, number: Number(number) }, discussion, note }
  }

  async replyThread(threadId: string, body: string, root: string): Promise<void> {
    const { ref, discussion } = this.decode(threadId)
    await this.api(ref.host, root, `${this.base(ref)}/discussions/${discussion}/notes`, {
      method: "POST",
      raw: { body },
    })
  }

  async resolveThread(threadId: string, resolved: boolean, root: string): Promise<void> {
    const { ref, discussion } = this.decode(threadId)
    await this.api(ref.host, root, `${this.base(ref)}/discussions/${discussion}`, {
      method: "PUT",
      typed: { resolved },
    })
  }

  async editComment(commentId: string, body: string, root: string): Promise<void> {
    const { ref, note } = this.decode(commentId)
    await this.api(ref.host, root, `${this.base(ref)}/notes/${note}`, { method: "PUT", raw: { body } })
  }

  async deleteComment(commentId: string, root: string): Promise<void> {
    const { ref, note } = this.decode(commentId)
    await this.api(ref.host, root, `${this.base(ref)}/notes/${note}`, { method: "DELETE" })
  }

  async fetchSuggestionSource(commentId: string, root: string): Promise<SuggestionSource> {
    const { ref, discussion, note } = this.decode(commentId)
    const [thread, mr] = await Promise.all([
      this.api(ref.host, root, `${this.base(ref)}/discussions/${discussion}`) as Promise<GlabDiscussion>,
      this.mr(ref, root),
    ])
    const notes = thread.notes ?? []
    const target = notes.find((item) => String(item.id) === note)
    const at = place(notes.at(0)?.position)
    const head = mr.diff_refs?.head_sha ?? mr.sha
    if (!target?.body || !at?.path || !head) throw new Error("GitLab suggestion could not be verified.")
    return {
      path: at.path,
      side: at.side,
      line: at.line,
      ...(at.startLine === undefined ? {} : { startLine: at.startLine }),
      outdated: !!at.head && at.head !== head,
      headRefOid: head,
      body: target.body,
    }
  }

  async react(commentId: string, content: PRReactionContent, add: boolean, root: string): Promise<void> {
    const emoji = EMOJI[content]
    if (!emoji) throw new Error(`GitLab does not support the "${content}" reaction.`)
    const { ref, note } = this.decode(commentId)
    const path = `${this.base(ref)}/notes/${note}/award_emoji`
    if (add) {
      await this.api(ref.host, root, path, { method: "POST", raw: { name: emoji } })
      return
    }
    const [list, viewer] = await Promise.all([this.restAwards(ref, root, note), this.viewer(ref.host, root)])
    const existing = list.find((item) => item.name === emoji && (!viewer || item.user?.username === viewer))
    if (existing?.id === undefined) return
    await this.api(ref.host, root, `${path}/${existing.id}`, { method: "DELETE" })
  }

  /** The rebase endpoint is asynchronous; poll until GitLab reports it finished. */
  private async rebase(ref: PrRef, root: string): Promise<string> {
    await this.api(ref.host, root, `${this.base(ref)}/rebase`, { method: "PUT" }, 30_000)
    const deadline = Date.now() + REBASE_TIMEOUT
    while (Date.now() < deadline) {
      const mr = await this.mr(ref, root, "?include_rebase_in_progress=true")
      if (!mr.rebase_in_progress) {
        if (mr.merge_error) throw new Error(`GitLab could not rebase: ${mr.merge_error}`)
        const head = mr.diff_refs?.head_sha ?? mr.sha
        if (!head) throw new Error("GitLab did not return the rebased head.")
        return head
      }
      await new Promise((resolve) => setTimeout(resolve, REBASE_POLL))
    }
    throw new Error("GitLab rebase is still running. Refresh and try again.")
  }

  async mergePr(ref: PrRef, method: PRMergeMethod, auto: boolean, headRefOid: string, root: string): Promise<void> {
    const current = await this.fetchDiffRefs(ref, root)
    if (current.headRefOid !== headRefOid) throw new Error("Pull request changed. Refresh and try again.")
    const head = method === "rebase" ? await this.rebase(ref, root) : headRefOid
    await this.api(
      ref.host,
      root,
      `${this.base(ref)}/merge`,
      {
        method: "PUT",
        raw: { sha: head },
        typed: {
          squash: method === "squash",
          // `auto_merge` replaces the deprecated flag on newer GitLab; older instances ignore it.
          ...(auto ? { merge_when_pipeline_succeeds: true, auto_merge: true } : {}),
        },
      },
      30_000,
    )
  }

  async updateBranchFromBase(ref: PrRef, root: string): Promise<void> {
    await this.rebase(ref, root)
  }

  async disableAutoMerge(ref: PrRef, root: string): Promise<void> {
    await this.api(ref.host, root, `${this.base(ref)}/cancel_merge_when_pipeline_succeeds`, { method: "POST" }, 20_000)
  }
}
