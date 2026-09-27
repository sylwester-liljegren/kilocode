import { afterEach, describe, expect, it } from "bun:test"
import { PRSuggestionActions } from "../../src/agent-manager/pr/suggestion-actions"
import { identifyPr } from "../../src/agent-manager/providers/registry"
import type { Provider, SuggestionSource } from "../../src/agent-manager/providers/provider"
import type { PRReviewContext, PRReviewHost } from "../../src/agent-manager/pr/review-context"
import type { PRStatus } from "../../src/agent-manager/types"

const URL = "https://git.example.com/group/repo/-/merge_requests/7"
const HEAD = "b".repeat(40)
const found = identifyPr(URL)
const gitlab = (found && found.provider !== "github" ? found.provider : undefined) as Provider
const original = gitlab.fetchSuggestionSource.bind(gitlab)

afterEach(() => {
  gitlab.fetchSuggestionSource = original
})

function context(): PRReviewContext {
  const pr = {
    number: 7,
    url: URL,
    headRefOid: HEAD,
    comments: {
      total: 1,
      unresolved: 1,
      comments: [{ id: "gitlab:c1", threadId: "gitlab:t1", author: "a", body: "", resolved: false, outdated: false }],
    },
  } as unknown as PRStatus
  return { pr, directory: "/repo", worktreeId: "wt", branch: "topic" }
}

async function source(body: string, extra: Partial<SuggestionSource> = {}, index = 0) {
  gitlab.fetchSuggestionSource = async () => ({
    path: "src/a.ts",
    side: "RIGHT",
    line: 10,
    outdated: false,
    headRefOid: HEAD,
    body,
    ...extra,
  })
  const actions = new PRSuggestionActions({} as PRReviewHost) as unknown as {
    source: (
      context: PRReviewContext,
      comment: string,
      index: number,
    ) => Promise<{ start: number; end: number; block: { text: string } }>
  }
  return actions.source(context(), "gitlab:c1", index)
}

describe("GitLab/Azure DevOps suggestion verification", () => {
  it("uses the thread's own range for a plain suggestion fence", async () => {
    const result = await source("```suggestion\nconst a = 1\n```", { startLine: 8 })
    expect([result.start, result.end, result.block.text]).toEqual([8, 10, "const a = 1"])
  })

  it("widens the range for GitLab's suggestion:-A+B fences", async () => {
    const result = await source("```suggestion:-2+1\nx\n```")
    expect([result.start, result.end]).toEqual([8, 11])
  })

  it("numbers blocks the same way the webview does", async () => {
    const result = await source("```suggestion:+1-1\nskip\n```\n\n```suggestion\npicked\n```", {}, 1)
    expect(result.block.text).toBe("picked")
  })

  it("rejects outdated, left-side, and stale-head suggestions", async () => {
    const body = "```suggestion\nx\n```"
    await expect(source(body, { outdated: true })).rejects.toThrow("current right-side thread")
    await expect(source(body, { side: "LEFT" })).rejects.toThrow("current right-side thread")
    await expect(source(body, { headRefOid: "c".repeat(40) })).rejects.toThrow("identity could not be verified")
  })

  it("rejects a range that would start before line 1", async () => {
    await expect(source("```suggestion:-20+0\nx\n```")).rejects.toThrow("Invalid suggestion range")
  })
})
