import { describe, expect, it } from "bun:test"
import { AzureDevOpsProvider } from "../../src/agent-manager/providers/azuredevops"
import { decodeThreadId, encodeThreadId, type PrRef } from "../../src/agent-manager/providers/provider"

type Invoke = { resource: string; route: Record<string, string>; method?: string; body?: unknown }

/** The real provider, with only its `az` boundary (`cli` and `devops invoke`) answered from canned JSON. */
function provider(opts: { cli?: (args: string[]) => unknown; invoke?: (call: Invoke) => unknown }) {
  const azure = new AzureDevOpsProvider()
  const cli: string[][] = []
  const invokes: Invoke[] = []
  const internal = azure as unknown as {
    cli: (root: string, args: string[]) => Promise<unknown>
    invoke: (
      root: string,
      owner: string,
      resource: string,
      route: Record<string, string>,
      o?: { method?: string; body?: unknown },
    ) => Promise<unknown>
  }
  internal.cli = async (_root, args) => {
    cli.push(args)
    return opts.cli?.(args)
  }
  internal.invoke = async (_root, _owner, resource, route, o = {}) => {
    const call = { resource, route, ...o }
    invokes.push(call)
    return opts.invoke?.(call)
  }
  return { azure, cli, invokes }
}

const REF: PrRef = { host: "dev.azure.com", owner: "org", project: "Proj", repo: "repo", number: 7 }
const HEAD = "b".repeat(40)
const pr = (extra: Record<string, unknown> = {}) => ({
  pullRequestId: 7,
  title: "Fix",
  description: "Body",
  status: "active",
  sourceRefName: "refs/heads/topic",
  targetRefName: "refs/heads/main",
  createdBy: { uniqueName: "me@corp.com" },
  repository: { webUrl: "https://dev.azure.com/org/Proj/_git/repo" },
  lastMergeSourceCommit: { commitId: HEAD },
  lastMergeTargetCommit: { commitId: "a".repeat(40) },
  mergeStatus: "succeeded",
  completionOptions: { deleteSourceBranch: true },
  reviewers: [
    { uniqueName: "one@corp.com", vote: 10 },
    { uniqueName: "two@corp.com", vote: -5 },
    { uniqueName: "three@corp.com", vote: 0 },
  ],
  ...extra,
})

const cli = (args: string[]) => {
  const command = args.slice(0, 3).join(" ")
  if (command === "repos pr show")
    return pr({ autoCompleteSetBy: { id: "x" }, completionOptions: { mergeStrategy: "rebaseMerge" } })
  if (command === "repos pr policy") {
    return [
      {
        status: "approved",
        configuration: {
          isEnabled: true,
          isBlocking: true,
          type: { displayName: "Build" },
          settings: { displayName: "CI build" },
        },
        context: { buildId: 42 },
      },
      {
        status: "rejected",
        configuration: {
          isEnabled: true,
          isBlocking: true,
          type: { displayName: "Minimum number of reviewers" },
          settings: {},
        },
      },
      {
        status: "approved",
        configuration: {
          isEnabled: true,
          isBlocking: true,
          type: { displayName: "Require a merge strategy" },
          settings: { allowSquash: true, allowNoFastForward: false, allowRebase: true },
        },
      },
      { status: "notApplicable", configuration: { isEnabled: true, type: { displayName: "Comment requirements" } } },
    ]
  }
  if (command === "account show --query") return "Me@Corp.com"
  return undefined
}

describe("AzureDevOpsProvider.fetchStatus", () => {
  it("maps votes, policy evaluations, PR statuses, merge-strategy policy and authorship", async () => {
    const { azure } = provider({
      cli,
      invoke: (call) =>
        call.resource === "pullRequestStatuses"
          ? {
              value: [
                { id: 1, state: "pending", context: { genre: "sec", name: "scan" } },
                { id: 2, state: "succeeded", context: { genre: "sec", name: "scan" }, targetUrl: "https://ci/scan" },
              ],
            }
          : undefined,
    })

    const status = await azure.fetchStatus(REF, "/repo")

    expect(status).toMatchObject({
      title: "Fix",
      body: "Body",
      url: "https://dev.azure.com/org/Proj/_git/repo/pullrequest/7",
      viewerDidAuthor: true,
      headRefOid: HEAD,
      merge: { mergeable: "mergeable", state: "blocked", auto: "rebase", methods: ["squash", "rebase"] },
    })
    expect(status.reviewers).toEqual([
      { login: "one@corp.com", state: "approved" },
      { login: "two@corp.com", state: "changes_requested" },
      { login: "three@corp.com", state: "pending" },
    ])
    expect(status.checks.checks.map((item) => [item.name, item.status, item.url])).toEqual([
      ["CI build", "success", "https://dev.azure.com/org/Proj/_build/results?buildId=42"],
      ["Minimum number of reviewers", "failure", undefined],
      ["Require a merge strategy", "success", undefined],
      ["sec/scan", "success", "https://ci/scan"],
    ])
  })
})

describe("AzureDevOpsProvider.fetchThreads", () => {
  it("maps file threads to review threads, general threads to the conversation, and likes to thumbs-up", async () => {
    const { azure } = provider({
      cli,
      invoke: (call) => ({
        value:
          call.resource !== "pullRequestThreads"
            ? []
            : [
                {
                  id: 11,
                  status: "active",
                  threadContext: { filePath: "/src/a.ts", rightFileStart: { line: 3 }, rightFileEnd: { line: 5 } },
                  comments: [
                    {
                      id: 1,
                      content: "Rename",
                      author: { uniqueName: "me@corp.com" },
                      publishedDate: "2026-01-01T00:00:00Z",
                      usersLiked: [{ uniqueName: "ME@corp.com" }, { uniqueName: "x@corp.com" }],
                    },
                    { id: 2, content: "Done", author: { uniqueName: "x@corp.com" } },
                    { id: 3, content: "gone", isDeleted: true },
                  ],
                },
                {
                  id: 12,
                  status: "fixed",
                  threadContext: { filePath: "/b.ts", leftFileEnd: { line: 9 } },
                  comments: [{ id: 1, content: "Old" }],
                },
                { id: 13, comments: [{ id: 1, content: "Voted", commentType: "system" }] },
                {
                  id: 14,
                  status: "active",
                  comments: [{ id: 1, content: "Looks good", author: { displayName: "Someone" } }],
                },
                { id: 15, isDeleted: true, comments: [{ id: 1, content: "deleted thread" }] },
              ],
      }),
    })

    const threads = await azure.fetchThreads(REF, "/repo")

    expect(threads.comments).toHaveLength(2)
    const [first, second] = threads.comments
    expect(first).toMatchObject({
      file: "src/a.ts",
      side: "additions",
      line: 5,
      startLine: 3,
      resolved: false,
      canEdit: true,
      url: "https://dev.azure.com/org/Proj/_git/repo/pullrequest/7?discussionId=11",
      reactions: [{ content: "THUMBS_UP", count: 2, viewerHasReacted: true }],
    })
    expect(first?.replies).toMatchObject([{ body: "Done", canEdit: false }])
    expect(decodeThreadId(first!.threadId)?.parts).toEqual(["org", "Proj", "repo", "7", "11", "1"])
    expect(second).toMatchObject({ file: "b.ts", side: "deletions", line: 9, resolved: true })
    expect(threads.conversation).toMatchObject([{ kind: "issue", author: "Someone", body: "Looks good" }])
  })
})

describe("AzureDevOpsProvider actions", () => {
  it("completes with the chosen merge strategy and the reviewed head as a guard", async () => {
    const { azure, invokes } = provider({ cli })
    await azure.mergePr(REF, "rebase", false, HEAD, "/repo")
    expect(invokes).toEqual([
      {
        resource: "pullRequests",
        route: { project: "Proj", repositoryId: "repo", pullRequestId: "7" },
        method: "PATCH",
        body: {
          status: "completed",
          lastMergeSourceCommit: { commitId: HEAD },
          completionOptions: { mergeStrategy: "rebase" },
        },
      },
    ])
  })

  it("sets auto-complete through the CLI, then only the merge strategy", async () => {
    const { azure, cli: calls, invokes } = provider({ cli: (args) => (args[2] === "show" ? pr() : undefined) })
    await azure.mergePr(REF, "squash", true, HEAD, "/repo")
    expect(calls.at(-1)).toEqual(expect.arrayContaining(["update", "--auto-complete", "true"]))
    expect(invokes.at(0)?.body).toEqual({ completionOptions: { deleteSourceBranch: true, mergeStrategy: "squash" } })
  })

  it("refuses to complete when the source branch moved", async () => {
    const { azure, invokes } = provider({ cli })
    await expect(azure.mergePr(REF, "merge", false, "e".repeat(40), "/repo")).rejects.toThrow("Pull request changed")
    expect(invokes).toEqual([])
  })

  it("casts a real vote for request-changes and posts the body as a comment", async () => {
    const { azure, cli: calls, invokes } = provider({ cli })
    await azure.submitReview(REF, "request_changes", "Please fix", HEAD, "/repo")
    expect(calls.at(0)).toEqual(expect.arrayContaining(["set-vote", "--vote", "wait-for-author"]))
    expect(invokes.at(0)).toMatchObject({ resource: "pullRequestThreads", method: "POST" })
  })

  it("approves with a vote and no comment when the body is empty", async () => {
    const { azure, cli: calls, invokes } = provider({ cli })
    await azure.submitReview(REF, "approve", "", HEAD, "/repo")
    expect(calls.at(0)).toEqual(expect.arrayContaining(["set-vote", "--vote", "approve"]))
    expect(invokes).toEqual([])
  })

  it("likes and unlikes through the comment likes resource, and rejects other reactions", async () => {
    const { azure, invokes } = provider({ cli })
    const id = encodeThreadId("azuredevops", "org", "Proj", "repo", 7, 11, 1)
    await azure.react(id, "THUMBS_UP", true, "/repo")
    await azure.react(id, "THUMBS_UP", false, "/repo")
    expect(invokes).toMatchObject([
      { resource: "pullRequestCommentLikes", route: { threadId: "11", commentId: "1" }, method: "POST" },
      { resource: "pullRequestCommentLikes", method: "DELETE" },
    ])
    await expect(azure.react(id, "HEART", true, "/repo")).rejects.toThrow("only supports liking")
  })

  it("round-trips project names with spaces and separators through thread ids", async () => {
    const { azure, invokes } = provider({ cli })
    const id = encodeThreadId("azuredevops", "org", "My: Project", "repo", 7, 11, 1)
    await azure.resolveThread(id, true, "/repo")
    expect(invokes.at(0)).toMatchObject({
      resource: "pullRequestThreads",
      route: { project: "My: Project", threadId: "11" },
      body: { status: "fixed" },
    })
  })
})

describe("AzureDevOpsProvider forks and timeline", () => {
  it("imports a forked PR from the fork's own remote", async () => {
    const { azure } = provider({
      cli: () =>
        pr({
          sourceRefName: "refs/heads/feature",
          forkSource: {
            name: "refs/heads/feature",
            repository: {
              name: "repo",
              project: { name: "Other Proj" },
              remoteUrl: "https://dev.azure.com/org/Other%20Proj/_git/repo",
            },
          },
        }),
    })
    expect(await azure.fetchPrInfo(REF, "/repo")).toEqual({
      headRefName: "feature",
      baseRefName: "main",
      title: "Fix",
      isCrossRepository: true,
      forkOwnerKey: "fork-other-proj-repo",
      forkRemoteUrl: "https://dev.azure.com/org/Other%20Proj/_git/repo",
    })
  })

  it("keeps a same-repository PR on origin", async () => {
    const { azure } = provider({ cli: () => pr() })
    expect(await azure.fetchPrInfo(REF, "/repo")).toMatchObject({ headRefName: "topic", isCrossRepository: false })
  })

  it("adds commits, status changes, and force pushes to the conversation in order", async () => {
    const status = (id: number, value: string, at: string) => ({
      id,
      publishedDate: at,
      properties: {
        CodeReviewThreadType: { $value: "StatusUpdate" },
        CodeReviewStatus: { $value: value },
        CodeReviewStatusUpdatedByIdentity: { $value: "1" },
      },
      identities: { "1": { uniqueName: "lead@corp.com" } },
      comments: [{ id: 1, content: "status", commentType: "system", author: { uniqueName: "bot" } }],
    })
    const { azure } = provider({
      cli: (args) => (args[2] === "show" ? pr({ status: "completed" }) : undefined),
      invoke: (call) => {
        if (call.resource === "pullRequestThreads")
          return {
            value: [
              status(20, "Active", "2026-01-01T00:00:00Z"),
              status(21, "Abandoned", "2026-01-03T00:00:00Z"),
              status(22, "Active", "2026-01-04T00:00:00Z"),
              status(23, "Completed", "2026-01-06T00:00:00Z"),
            ],
          }
        if (call.resource === "pullRequestCommits")
          return {
            value: [
              {
                commitId: "1234567890abcdef",
                comment: "Add feature\n\nDetails",
                author: { name: "Dev", date: "2026-01-02T00:00:00Z" },
                committer: { date: "2026-01-02T00:00:00Z" },
              },
            ],
          }
        if (call.resource === "pullRequestIterations")
          return {
            value: [
              { id: 1, reason: "create", sourceRefCommit: { commitId: "aaaaaaaaaa" } },
              {
                id: 2,
                reason: "forcePush",
                createdDate: "2026-01-05T00:00:00Z",
                author: { uniqueName: "dev@corp.com" },
                sourceRefCommit: { commitId: "bbbbbbbbbb" },
              },
            ],
          }
        return undefined
      },
    })

    const threads = await azure.fetchThreads(REF, "/repo")

    expect(threads.conversation).toEqual([
      expect.objectContaining({
        kind: "commit",
        short: "1234567",
        message: "Add feature",
        author: "Dev",
        url: "https://dev.azure.com/org/Proj/_git/repo/commit/1234567890abcdef",
      }),
      expect.objectContaining({ kind: "event", event: "closed", actor: "lead@corp.com" }),
      expect.objectContaining({ kind: "event", event: "reopened" }),
      expect.objectContaining({
        kind: "event",
        event: "force_pushed",
        actor: "dev@corp.com",
        detail: "aaaaaaa to bbbbbbb",
      }),
      expect.objectContaining({ kind: "event", event: "merged", detail: "main" }),
    ])
  })

  it("falls back to the PR's own close fields when there is no status thread", async () => {
    const { azure } = provider({
      cli: (args) =>
        args[2] === "show"
          ? pr({ status: "abandoned", closedDate: "2026-01-09T00:00:00Z", closedBy: { uniqueName: "x@corp.com" } })
          : undefined,
      invoke: () => ({ value: [] }),
    })
    const threads = await azure.fetchThreads(REF, "/repo")
    expect(threads.conversation).toEqual([
      expect.objectContaining({ kind: "event", event: "closed", actor: "x@corp.com" }),
    ])
  })
})
