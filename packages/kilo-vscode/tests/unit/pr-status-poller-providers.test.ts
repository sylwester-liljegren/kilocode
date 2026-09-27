import { describe, expect, it } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { PRStatusPoller } from "../../src/agent-manager/PRStatusPoller"
import type { Worktree } from "../../src/agent-manager/WorktreeStateManager"
import type {
  PrRef,
  Provider,
  ProviderLabels,
  ProviderPrStatus,
  ProviderThreads,
} from "../../src/agent-manager/providers/provider"
import type { PRStatus } from "../../src/agent-manager/types"

const BASE: Omit<PrRef, "number"> = { host: "gitlab.com", owner: "group", repo: "repo" }
const LABELS: ProviderLabels = { service: "GitLab", tool: "GitLab CLI (glab)", login: "glab auth login" }
const NONE = { status: "none", total: 0, passed: 0, failed: 0, pending: 0, checks: [] } as const
const unused = () => Promise.reject(new Error("not used"))

function fakeProvider(status: Partial<ProviderPrStatus>, threads?: ProviderThreads): Provider {
  return {
    id: "gitlab",
    cliBin: "glab",
    labels: LABELS,
    authHint: "",
    missingHint: "",
    detectHost: () => true,
    parsePrUrl: () => null,
    classifyCliError: () => "unknown",
    pullRef: () => "refs/merge-requests/1/head",
    fetchPrInfo: unused,
    fetchStatus: () =>
      Promise.resolve({ title: "t", url: "u", state: "open", checks: { ...NONE }, reviewers: [], ...status }),
    fetchThreads: () => (threads ? Promise.resolve(threads) : unused()),
    parseRemote: () => BASE,
    findOpenByBranch: (base) => Promise.resolve({ ...base, number: 7 }),
    fetchDiffRefs: unused,
    postComment: unused,
    postGeneralComment: unused,
    submitReview: unused,
    replyThread: unused,
    resolveThread: unused,
    editComment: unused,
    deleteComment: unused,
    fetchSuggestionSource: unused,
    react: unused,
    mergePr: unused,
    updateBranchFromBase: unused,
    disableAutoMerge: unused,
  }
}

type Internal = {
  remoteProvider(cwd: string): Promise<{ provider: Provider; base: Omit<PrRef, "number"> } | undefined>
  fetchOne(id: string, generation?: number, full?: boolean): Promise<void>
}

async function run(
  provider: Provider,
  full = false,
  saved?: "merge" | "squash" | "rebase",
  setup?: (dir: string) => void,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-pr-provider-"))
  setup?.(dir)
  const statuses: (PRStatus | null)[] = []
  const errors: { error: string; source?: ProviderLabels }[] = []
  try {
    const tree: Worktree = {
      id: "wt1",
      branch: "feature",
      path: dir,
      parentBranch: "main",
      createdAt: "2026-01-01T00:00:00.000Z",
    }
    const instance = new PRStatusPoller({
      getWorktrees: () => [tree],
      getWorkspaceRoot: () => path.dirname(dir),
      onStatus: (_id, pr, error, _branch, source) => {
        statuses.push(pr)
        if (error) errors.push({ error, source })
      },
      log: () => {},
      getPRMergeMethod: () => saved,
    })
    const internal = instance as unknown as Internal
    internal.remoteProvider = async () => ({ provider, base: BASE })
    await internal.fetchOne("wt1", 0, full)
    return { statuses, errors }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe("PRStatusPoller — non-GitHub providers", () => {
  it("builds a PRStatus with checks, review decision, head/base and merge panel state", async () => {
    const provider = fakeProvider({
      title: "Fix bug",
      url: "https://gitlab.com/group/repo/-/merge_requests/7",
      author: "octocat",
      viewerDidAuthor: true,
      baseRefOid: "a".repeat(40),
      headRefOid: "b".repeat(40),
      checks: {
        status: "success",
        total: 1,
        passed: 1,
        failed: 0,
        pending: 0,
        checks: [{ name: "test", status: "success" }],
      },
      reviewers: [
        { login: "one", state: "approved" },
        { login: "two", state: "changes_requested" },
      ],
      merge: {
        mergeable: "mergeable",
        state: "clean",
        auto: null,
        methods: ["merge", "rebase"],
        autoAllowed: true,
        canWrite: true,
      },
    })

    const { statuses, errors } = await run(provider, false, "rebase")

    expect(errors).toEqual([])
    expect(statuses.at(0)).toMatchObject({
      number: 7,
      title: "Fix bug",
      viewerDidAuthor: true,
      baseRefOid: "a".repeat(40),
      headRefOid: "b".repeat(40),
      review: "changes_requested",
      checks: { status: "success", checks: [{ name: "test", status: "success" }] },
      merge: { method: "rebase", methods: ["merge", "rebase"] },
    })
    expect(statuses.at(0)?.comments).toBeUndefined()
  })

  it("falls back from an unavailable saved merge method to squash, then to the first allowed", async () => {
    const merge = { mergeable: "mergeable", state: "clean", auto: null, autoAllowed: true, canWrite: true } as const
    const squash = await run(fakeProvider({ merge: { ...merge, methods: ["merge", "squash"] } }), false, "rebase")
    expect(squash.statuses.at(0)?.merge?.method).toBe("squash")
    const first = await run(fakeProvider({ merge: { ...merge, methods: ["merge"] } }), false, "rebase")
    expect(first.statuses.at(0)?.merge?.method).toBe("merge")
  })

  it("loads review threads and conversation only for a full (active worktree) fetch", async () => {
    const threads: ProviderThreads = {
      comments: [
        { id: "c1", threadId: "c1", author: "a", body: "fix", resolved: false, outdated: false },
        { id: "c2", threadId: "c2", author: "b", body: "ok", resolved: true, outdated: false },
      ],
      conversation: [{ kind: "issue", id: "n1", author: "a", body: "hello" }],
    }
    const { statuses } = await run(fakeProvider({}, threads), true)

    expect(statuses.at(0)?.unresolvedThreads).toBe(1)
    expect(statuses.at(0)?.comments).toMatchObject({ total: 2, unresolved: 1 })
    expect(statuses.at(0)?.comments?.comments.map((item) => item.id)).toEqual(["c1", "c2"])
    expect(statuses.at(0)?.conversation).toEqual(threads.conversation)
  })

  it("keeps the status when thread loading fails", async () => {
    const { statuses, errors } = await run(fakeProvider({ title: "Still here" }), true)
    expect(errors).toEqual([])
    expect(statuses.at(0)).toMatchObject({ title: "Still here" })
    expect(statuses.at(0)?.comments).toBeUndefined()
  })

  it("finds a fork PR through the branch the local fork branch tracks", async () => {
    const asked: string[] = []
    const provider = fakeProvider({ title: "From fork" })
    provider.findOpenByBranch = (base, branch) => {
      asked.push(branch)
      return Promise.resolve(branch === "topic" ? { ...base, number: 9 } : null)
    }
    const { statuses } = await run(provider, false, undefined, (dir) => {
      Bun.spawnSync(["git", "init", "-q", dir])
      Bun.spawnSync(["git", "-C", dir, "config", "branch.feature.merge", "refs/heads/topic"])
    })
    expect(asked).toEqual(["feature", "topic"])
    expect(statuses.at(0)).toMatchObject({ number: 9, title: "From fork" })
  })

  it("reports no PR when the branch has none open", async () => {
    const provider = fakeProvider({})
    provider.findOpenByBranch = () => Promise.resolve(null)
    const { statuses, errors } = await run(provider)
    expect(errors).toEqual([])
    expect(statuses).toEqual([null])
  })

  it("reports a CLI error with the provider's labels so the toast names the right tool", async () => {
    const provider = fakeProvider({})
    provider.findOpenByBranch = () => Promise.reject(new Error("glab: command not found"))
    provider.classifyCliError = () => "cli_missing"
    const { errors } = await run(provider)
    expect(errors).toEqual([{ error: "gh_missing", source: LABELS }])
  })
})
