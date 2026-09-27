import { describe, expect, it } from "bun:test"
import { GitLabProvider } from "../../src/agent-manager/providers/gitlab"
import { decodeThreadId, type PrRef } from "../../src/agent-manager/providers/provider"

type Call = {
  host: string
  path: string
  method?: string
  raw?: Record<string, string>
  typed?: Record<string, unknown>
}
type Route = (call: Call, count: number) => unknown

/** The real provider, with only its single `glab api` boundary answered from canned JSON. */
function provider(routes: Record<string, Route | unknown>) {
  const gitlab = new GitLabProvider()
  const calls: Call[] = []
  const counts = new Map<string, number>()
  const internal = gitlab as unknown as {
    api: (host: string, root: string, path: string, opts?: Omit<Call, "host" | "path">) => Promise<unknown>
  }
  internal.api = async (host, _root, path, opts = {}) => {
    const call = { host, path, ...opts }
    calls.push(call)
    const key = `${opts.method ?? "GET"} ${path}`
    const count = (counts.get(key) ?? 0) + 1
    counts.set(key, count)
    if (!(key in routes)) throw new Error(`404 Not Found: ${key}`)
    const route = routes[key]
    return typeof route === "function" ? (route as Route)(call, count) : route
  }
  return { gitlab, calls }
}

type Award = { name: string; user: { username: string } }

/** A GraphQL notes page, answered once per call; `after` pages are keyed by cursor. */
function graph(nodes: unknown[], pages: Record<string, { nodes: unknown[]; next?: string }> = {}, next?: string) {
  return (call: Call) => {
    const page = call.raw?.after ? pages[call.raw.after] : { nodes, next }
    return {
      data: {
        project: {
          mergeRequest: {
            notes: { pageInfo: { hasNextPage: !!page?.next, endCursor: page?.next ?? null }, nodes: page?.nodes ?? [] },
          },
        },
      },
    }
  }
}

function note(id: string, awards: Award[], more = false) {
  return { id, awardEmoji: { pageInfo: { hasNextPage: more }, nodes: awards } }
}

const REF: PrRef = { host: "gitlab.com", owner: "group/sub", repo: "repo", number: 7 }
const MR = "projects/group%2Fsub%2Frepo/merge_requests/7"
const HEAD = "b".repeat(40)
const mr = (extra: Record<string, unknown> = {}) => ({
  iid: 7,
  title: "Fix",
  description: "Body",
  source_branch: "topic",
  target_branch: "main",
  source_project_id: 1,
  target_project_id: 1,
  web_url: "https://gitlab.com/group/sub/repo/-/merge_requests/7",
  state: "opened",
  author: { username: "me" },
  diff_refs: { base_sha: "a".repeat(40), head_sha: HEAD, start_sha: "c".repeat(40) },
  ...extra,
})

describe("GitLabProvider.fetchStatus", () => {
  it("maps merge state, pipeline jobs, reviewer states and authorship", async () => {
    const { gitlab } = provider({
      [`GET ${MR}`]: mr({
        detailed_merge_status: "need_rebase",
        merge_when_pipeline_succeeds: true,
        squash: false,
        user: { can_merge: false },
      }),
      "GET projects/group%2Fsub%2Frepo": { path_with_namespace: "group/sub/repo", squash_option: "never" },
      [`GET ${MR}/pipelines`]: [{ id: 5, status: "failed" }],
      "GET projects/group%2Fsub%2Frepo/pipelines/5/jobs?per_page=100": [
        { name: "lint", status: "success", started_at: "2026-01-01T00:00:00Z", finished_at: "2026-01-01T00:01:05Z" },
        { name: "test", status: "failed", web_url: "https://gitlab.com/group/sub/repo/-/jobs/9" },
        { name: "flaky", status: "failed", allow_failure: true },
        { name: "deploy", status: "manual" },
      ],
      [`GET ${MR}/reviewers`]: [
        { user: { username: "a" }, state: "requested_changes" },
        { user: { username: "b" }, state: "reviewed" },
      ],
      [`GET ${MR}/approvals`]: { approved_by: [{ user: { username: "c" } }] },
      "GET user": { username: "me" },
    })

    const status = await gitlab.fetchStatus(REF, "/repo")

    expect(status).toMatchObject({
      title: "Fix",
      body: "Body",
      state: "open",
      viewerDidAuthor: true,
      headRefOid: HEAD,
      merge: {
        mergeable: "mergeable",
        state: "behind",
        auto: "merge",
        methods: ["merge", "rebase"],
        canWrite: false,
      },
    })
    expect(status.checks).toMatchObject({ status: "failure", total: 2, passed: 1, failed: 1 })
    expect(status.checks.checks.map((item) => [item.name, item.status])).toEqual([
      ["lint", "success"],
      ["test", "failure"],
      ["flaky", "skipped"],
      ["deploy", "skipped"],
    ])
    expect(status.checks.checks.at(0)?.duration).toBe("1m 5s")
    expect(status.reviewers).toEqual([
      { login: "a", avatar: undefined, state: "changes_requested" },
      { login: "b", avatar: undefined, state: "commented" },
      { login: "c", avatar: undefined, state: "approved" },
    ])
  })
})

describe("GitLabProvider.fetchThreads", () => {
  it("maps diff discussions to threads and general notes to the conversation", async () => {
    const { gitlab } = provider({
      [`GET ${MR}`]: mr(),
      "GET user": { username: "me" },
      [`GET ${MR}/discussions?per_page=100&page=1`]: [
        {
          id: "d1",
          notes: [
            {
              id: 101,
              body: "Use a const",
              author: { username: "me" },
              created_at: "2026-01-02T00:00:00Z",
              resolvable: true,
              resolved: true,
              position: {
                new_path: "src/a.ts",
                old_path: "src/a.ts",
                new_line: 12,
                old_line: null,
                head_sha: "old",
                line_range: { start: { new_line: 10 } },
              },
            },
            { id: 102, body: "Done", author: { username: "other" }, resolvable: true, resolved: false },
          ],
        },
        { id: "d2", notes: [{ id: 201, body: "merged", system: true }] },
        {
          id: "d3",
          notes: [
            { id: 302, body: "Second", author: { username: "x" }, created_at: "2026-01-03T00:00:00Z" },
            { id: 301, body: "First", author: { username: "me" }, created_at: "2026-01-01T00:00:00Z" },
          ],
        },
      ],
      "POST graphql": graph([
        note("gid://gitlab/DiffNote/101", [
          { name: "thumbsup", user: { username: "me" } },
          { name: "thumbsup", user: { username: "x" } },
          { name: "not-mapped", user: { username: "x" } },
        ]),
        note("gid://gitlab/DiffNote/102", []),
        note("gid://gitlab/Note/301", [{ name: "tada", user: { username: "x" } }]),
        note("gid://gitlab/Note/302", []),
      ]),
    })

    const threads = await gitlab.fetchThreads(REF, "/repo", HEAD)

    expect(threads.comments).toHaveLength(1)
    const comment = threads.comments.at(0)!
    expect(comment).toMatchObject({
      author: "me",
      body: "Use a const",
      file: "src/a.ts",
      side: "additions",
      line: 12,
      startLine: 10,
      resolved: false,
      outdated: true,
      canEdit: true,
      canDelete: true,
      url: "https://gitlab.com/group/sub/repo/-/merge_requests/7#note_101",
      reactions: [{ content: "THUMBS_UP", count: 2, viewerHasReacted: true }],
    })
    expect(comment.threadId).toBe(comment.id)
    expect(decodeThreadId(comment.id)?.parts).toEqual(["gitlab.com", "group/sub", "repo", "7", "d1", "101"])
    expect(comment.replies).toMatchObject([{ author: "other", body: "Done", canEdit: false }])
    expect(threads.conversation.map((item) => (item as { body: string }).body)).toEqual(["First", "Second"])
    expect(threads.conversation.at(0)).toMatchObject({
      kind: "issue",
      canEdit: true,
      reactions: [{ content: "HOORAY", count: 1, viewerHasReacted: false }],
    })
  })
})

describe("GitLabProvider actions", () => {
  it("rebase-merges by waiting for the async rebase, then accepting the rebased head", async () => {
    const rebased = "d".repeat(40)
    const { gitlab, calls } = provider({
      [`GET ${MR}`]: mr(),
      [`PUT ${MR}/rebase`]: { rebase_in_progress: true },
      [`GET ${MR}?include_rebase_in_progress=true`]: (_: Call, count: number) =>
        count === 1
          ? mr({ rebase_in_progress: true })
          : mr({ rebase_in_progress: false, diff_refs: { base_sha: "a".repeat(40), head_sha: rebased } }),
      [`PUT ${MR}/merge`]: {},
    })

    await gitlab.mergePr(REF, "rebase", false, HEAD, "/repo")

    const merge = calls.at(-1)!
    expect(merge.path).toBe(`${MR}/merge`)
    expect(merge.raw).toEqual({ sha: rebased })
    expect(merge.typed).toEqual({ squash: false })
  })

  it("squash-merges with auto-merge and the head commit as a guard", async () => {
    const { gitlab, calls } = provider({ [`GET ${MR}`]: mr(), [`PUT ${MR}/merge`]: {} })
    await gitlab.mergePr(REF, "squash", true, HEAD, "/repo")
    expect(calls.at(-1)).toMatchObject({
      raw: { sha: HEAD },
      typed: { squash: true, merge_when_pipeline_succeeds: true, auto_merge: true },
    })
  })

  it("refuses to merge when the MR head moved", async () => {
    const { gitlab, calls } = provider({ [`GET ${MR}`]: mr() })
    await expect(gitlab.mergePr(REF, "merge", false, "e".repeat(40), "/repo")).rejects.toThrow("Pull request changed")
    expect(calls.every((call) => !call.method)).toBe(true)
  })

  it("requests changes through a published review, not a plain note", async () => {
    const { gitlab, calls } = provider({ [`POST ${MR}/draft_notes/bulk_publish`]: {} })
    await gitlab.submitReview(REF, "request_changes", "Please fix", HEAD, "/repo")
    expect(calls).toMatchObject([
      { path: `${MR}/draft_notes/bulk_publish`, raw: { reviewer_state: "requested_changes", note: "Please fix" } },
    ])
  })

  it("cancels auto-merge through its dedicated endpoint", async () => {
    const { gitlab, calls } = provider({ [`POST ${MR}/cancel_merge_when_pipeline_succeeds`]: {} })
    await gitlab.disableAutoMerge(REF, "/repo")
    expect(calls.at(0)?.path).toBe(`${MR}/cancel_merge_when_pipeline_succeeds`)
  })

  it("removes only the viewer's own award, on the MR note endpoint", async () => {
    const { gitlab, calls } = provider({
      "GET user": { username: "me" },
      [`GET ${MR}/notes/101/award_emoji?per_page=100&page=1`]: [
        { id: 1, name: "thumbsup", user: { username: "x" } },
        { id: 2, name: "thumbsup", user: { username: "me" } },
      ],
      [`DELETE ${MR}/notes/101/award_emoji/2`]: undefined,
    })
    const id = (await import("../../src/agent-manager/providers/provider")).encodeThreadId(
      "gitlab",
      "gitlab.com",
      "group/sub",
      "repo",
      7,
      "d1",
      101,
    )
    await gitlab.react(id, "THUMBS_UP", false, "/repo")
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: `${MR}/notes/101/award_emoji/2` })
  })

  it("routes thread actions to the self-managed host encoded in the id", async () => {
    const { gitlab, calls } = provider({
      "POST projects/team%2Frepo/merge_requests/3/discussions/d9/notes": {},
    })
    const { encodeThreadId } = await import("../../src/agent-manager/providers/provider")
    await gitlab.replyThread(encodeThreadId("gitlab", "git.example.com", "team", "repo", 3, "d9", 1), "Thanks", "/repo")
    expect(calls).toMatchObject([{ host: "git.example.com", raw: { body: "Thanks" } }])
  })

  it("does not offer a reaction GitLab has no emoji for", async () => {
    const { gitlab } = provider({})
    await expect(gitlab.react("gitlab:h:o:r:1:d:1", "CONFUSED", true, "/repo")).rejects.toThrow("does not support")
  })
})

describe("GitLabProvider timeline", () => {
  it("adds commits and merged/closed/reopened state events to the conversation in order", async () => {
    const { gitlab } = provider({
      [`GET ${MR}`]: mr({ state: "merged" }),
      "GET user": { username: "me" },
      [`GET ${MR}/discussions?per_page=100&page=1`]: [
        { id: "d1", notes: [{ id: 1, body: "Hello", author: { username: "me" }, created_at: "2026-01-02T00:00:00Z" }] },
      ],
      "POST graphql": graph([note("gid://gitlab/Note/1", [])]),
      [`GET ${MR}/commits?per_page=100&page=1`]: [
        {
          id: "1234567890abcdef",
          short_id: "12345678",
          title: "Add feature",
          author_name: "Dev",
          committed_date: "2026-01-01T00:00:00Z",
          web_url: "https://gitlab.com/group/sub/repo/-/commit/1234567890abcdef",
        },
      ],
      [`GET ${MR}/resource_state_events?per_page=100&page=1`]: [
        { id: 1, state: "opened", created_at: "2026-01-01T00:00:00Z", user: { username: "me" } },
        { id: 2, state: "closed", created_at: "2026-01-03T00:00:00Z", user: { username: "lead" } },
        { id: 3, state: "reopened", created_at: "2026-01-04T00:00:00Z", user: { username: "lead" } },
        { id: 4, state: "merged", created_at: "2026-01-05T00:00:00Z", user: { username: "lead" } },
      ],
    })

    const threads = await gitlab.fetchThreads(REF, "/repo", HEAD)

    expect(threads.conversation).toEqual([
      expect.objectContaining({ kind: "commit", short: "12345678", message: "Add feature", author: "Dev" }),
      expect.objectContaining({ kind: "issue", body: "Hello" }),
      expect.objectContaining({ kind: "event", event: "closed", actor: "lead" }),
      expect.objectContaining({ kind: "event", event: "reopened", actor: "lead" }),
      expect.objectContaining({ kind: "event", event: "merged", actor: "lead", detail: "main" }),
    ])
  })

  it("falls back to the MR's own merged fields when there are no state events", async () => {
    const { gitlab } = provider({
      [`GET ${MR}`]: mr({ state: "merged", merged_at: "2026-01-05T00:00:00Z", merged_by: { username: "lead" } }),
      "GET user": { username: "me" },
      [`GET ${MR}/discussions?per_page=100&page=1`]: [],
    })
    const threads = await gitlab.fetchThreads(REF, "/repo", HEAD)
    expect(threads.conversation).toEqual([
      expect.objectContaining({ kind: "event", event: "merged", actor: "lead", detail: "main" }),
    ])
  })
})

describe("GitLabProvider reactions without a cap", () => {
  const thumbs = (count: number, viewer?: string) =>
    Array.from({ length: count }, (_, index) => ({
      name: "thumbsup",
      user: { username: index === 0 && viewer ? viewer : `u${index}` },
    }))
  const general = (count: number) => [
    {
      id: "d",
      notes: Array.from({ length: count }, (_, index) => ({
        id: index + 1,
        body: `n${index + 1}`,
        author: { username: "x" },
      })),
    },
  ]

  it("loads reactions for every note across GraphQL pages, far past 100 notes", async () => {
    const { gitlab, calls } = provider({
      [`GET ${MR}`]: mr(),
      "GET user": { username: "me" },
      [`GET ${MR}/discussions?per_page=100&page=1`]: general(150),
      "POST graphql": graph(
        Array.from({ length: 100 }, (_, index) => note(`gid://gitlab/Note/${index + 1}`, thumbs(1))),
        {
          c1: {
            nodes: Array.from({ length: 50 }, (_, index) => note(`gid://gitlab/Note/${index + 101}`, thumbs(2, "me"))),
          },
        },
        "c1",
      ),
    })

    const threads = await gitlab.fetchThreads(REF, "/repo", HEAD)

    const items = threads.conversation as Array<{ body: string; reactions?: unknown }>
    expect(items).toHaveLength(150)
    expect(items.every((item) => item.reactions !== undefined)).toBe(true)
    expect(items.find((item) => item.body === "n150")?.reactions).toEqual([
      { content: "THUMBS_UP", count: 2, viewerHasReacted: true },
    ])
    expect(calls.filter((call) => call.path === "graphql").map((call) => call.raw?.after)).toEqual([undefined, "c1"])
    expect(calls.some((call) => call.path.includes("award_emoji"))).toBe(false)
  })

  it("pages a single note's reactions over REST when it has more than GraphQL returned", async () => {
    const { gitlab } = provider({
      [`GET ${MR}`]: mr(),
      "GET user": { username: "me" },
      [`GET ${MR}/discussions?per_page=100&page=1`]: general(1),
      "POST graphql": graph([note("gid://gitlab/Note/1", thumbs(100), true)]),
      [`GET ${MR}/notes/1/award_emoji?per_page=100&page=1`]: thumbs(100),
      [`GET ${MR}/notes/1/award_emoji?per_page=100&page=2`]: thumbs(30, "me"),
    })

    const threads = await gitlab.fetchThreads(REF, "/repo", HEAD)

    expect((threads.conversation.at(0) as { reactions?: unknown }).reactions).toEqual([
      { content: "THUMBS_UP", count: 130, viewerHasReacted: true },
    ])
  })

  it("falls back to paged REST for every note when GraphQL can't answer", async () => {
    const { gitlab, calls } = provider({
      [`GET ${MR}`]: mr(),
      "GET user": { username: "me" },
      [`GET ${MR}/discussions?per_page=100&page=1`]: general(2),
      "POST graphql": { errors: [{ message: "Field 'awardEmoji' doesn't exist on type 'Note'" }] },
      [`GET ${MR}/notes/1/award_emoji?per_page=100&page=1`]: thumbs(3),
      [`GET ${MR}/notes/2/award_emoji?per_page=100&page=1`]: [],
    })

    const threads = await gitlab.fetchThreads(REF, "/repo", HEAD)

    const items = threads.conversation as Array<{ body: string; reactions?: unknown }>
    expect(items.find((item) => item.body === "n1")?.reactions).toEqual([
      { content: "THUMBS_UP", count: 3, viewerHasReacted: false },
    ])
    expect(items.find((item) => item.body === "n2")?.reactions).toBeUndefined()
    expect(calls.filter((call) => call.path.includes("award_emoji"))).toHaveLength(2)
  })
})
