import { describe, expect, it } from "bun:test"
import { openLabel, prHost, reactionChoices } from "../../webview-ui/agent-manager/pr/pr-host"
import { reportFailure } from "../../webview-ui/agent-manager/failure-toast"
import { dict } from "../../webview-ui/agent-manager/i18n/en"
import { resolveTemplate } from "../../webview-ui/src/context/language-utils"

describe("prHost", () => {
  it("recognizes each service from the URL path, including self-managed and legacy hosts", () => {
    expect(prHost("https://github.com/o/r/pull/1")).toBe("github")
    expect(prHost("https://git.example.com/group/sub/repo/-/merge_requests/3")).toBe("gitlab")
    expect(prHost("https://dev.azure.com/org/Proj/_git/repo/pullrequest/9?discussionId=2")).toBe("azuredevops")
    expect(prHost("https://org.visualstudio.com/Proj/_git/repo/pullrequest/9")).toBe("azuredevops")
    expect(prHost(undefined)).toBe("github")
  })

  it("offers only the reactions each service supports, with the matching open label", () => {
    expect(reactionChoices("https://github.com/o/r/pull/1")).toHaveLength(8)
    expect(reactionChoices("https://gitlab.com/g/r/-/merge_requests/1")).not.toContain("CONFUSED")
    expect(reactionChoices("https://dev.azure.com/o/p/_git/r/pullrequest/1")).toEqual(["THUMBS_UP"])
    for (const url of [
      "https://github.com/o/r/pull/1",
      "https://gitlab.com/g/r/-/merge_requests/1",
      "https://dev.azure.com/o/p/_git/r/pullrequest/1",
    ])
      expect(dict[openLabel(url) as keyof typeof dict]).toBeDefined()
  })
})

describe("PR error toast", () => {
  const t = (key: string, params?: Record<string, string>) =>
    resolveTemplate((dict as Record<string, string>)[key] ?? key, params)

  function toast(message: Record<string, unknown>) {
    const shown: { title: string; description: string }[] = []
    reportFailure(
      { type: "agentManager.prError", ...message },
      { toast: (item) => shown.push(item), t, project: undefined },
    )
    return shown.at(0)
  }

  it("names the provider's service and CLI when the error came from GitLab or Azure DevOps", () => {
    const source = { service: "GitLab", tool: "GitLab CLI (glab)", login: "glab auth login" }
    expect(toast({ error: "gh_auth", source })).toMatchObject({
      title: "GitLab authentication required",
      description: "Run 'glab auth login' in your terminal to restore PR status.",
    })
    expect(toast({ error: "gh_missing", source })?.title).toBe("GitLab CLI (glab) not installed")
  })

  it("keeps GitHub's dedicated copy when no provider is attached", () => {
    expect(toast({ error: "gh_missing" })?.title).toBe(dict["agentManager.pr.error.gh_missing.title"])
  })
})
