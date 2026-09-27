import { describe, expect, it } from "bun:test"
import { AzureDevOpsProvider } from "../../src/agent-manager/providers/azuredevops"
import { GitLabProvider } from "../../src/agent-manager/providers/gitlab"
import { identifyPr, parseNonGitHubPrUrl, resolveRemote } from "../../src/agent-manager/providers/registry"
import { decodeThreadId, encodeThreadId } from "../../src/agent-manager/providers/provider"

const gitlab = new GitLabProvider()
const azure = new AzureDevOpsProvider()

describe("GitLabProvider.parsePrUrl", () => {
  it("parses a standard merge request URL", () => {
    expect(gitlab.parsePrUrl("https://gitlab.com/owner/repo/-/merge_requests/42")).toEqual({
      host: "gitlab.com",
      owner: "owner",
      repo: "repo",
      number: 42,
    })
  })

  it("handles nested subgroups", () => {
    expect(gitlab.parsePrUrl("https://gitlab.com/group/subgroup/repo/-/merge_requests/7")).toEqual({
      host: "gitlab.com",
      owner: "group/subgroup",
      repo: "repo",
      number: 7,
    })
  })

  it("handles a self-managed GitLab host", () => {
    expect(gitlab.parsePrUrl("https://gitlab.example.com/owner/repo/-/merge_requests/1")).toEqual({
      host: "gitlab.example.com",
      owner: "owner",
      repo: "repo",
      number: 1,
    })
  })

  it("returns null for a GitHub PR URL", () => {
    expect(gitlab.parsePrUrl("https://github.com/owner/repo/pull/1")).toBeNull()
  })

  it("returns null without a merge request number", () => {
    expect(gitlab.parsePrUrl("https://gitlab.com/owner/repo/-/merge_requests/")).toBeNull()
  })
})

describe("GitLabProvider.classifyCliError", () => {
  it("detects glab CLI missing", () => {
    expect(gitlab.classifyCliError("glab: command not found")).toBe("cli_missing")
    expect(gitlab.classifyCliError("spawn glab ENOENT")).toBe("cli_missing")
  })

  it("detects glab auth issue", () => {
    expect(gitlab.classifyCliError("not logged in. Run `glab auth login`")).toBe("cli_auth")
  })

  it("detects not found", () => {
    expect(gitlab.classifyCliError("404 Not Found")).toBe("not_found")
  })

  it("returns unknown for unrecognized errors", () => {
    expect(gitlab.classifyCliError("something went wrong")).toBe("unknown")
  })
})

describe("AzureDevOpsProvider.parsePrUrl", () => {
  it("parses a modern dev.azure.com URL", () => {
    expect(azure.parsePrUrl("https://dev.azure.com/myorg/myproject/_git/myrepo/pullrequest/123")).toEqual({
      host: "dev.azure.com",
      owner: "myorg",
      project: "myproject",
      repo: "myrepo",
      number: 123,
    })
  })

  it("parses a legacy visualstudio.com URL", () => {
    expect(azure.parsePrUrl("https://myorg.visualstudio.com/myproject/_git/myrepo/pullrequest/5")).toEqual({
      host: "dev.azure.com",
      owner: "myorg",
      project: "myproject",
      repo: "myrepo",
      number: 5,
    })
  })

  it("returns null for a GitHub PR URL", () => {
    expect(azure.parsePrUrl("https://github.com/owner/repo/pull/1")).toBeNull()
  })
})

describe("AzureDevOpsProvider.classifyCliError", () => {
  it("detects az CLI missing", () => {
    expect(azure.classifyCliError("az: command not found")).toBe("cli_missing")
  })

  it("detects the azure-devops extension missing", () => {
    expect(azure.classifyCliError("the azure-devops extension is not installed")).toBe("cli_missing")
  })

  it("detects az login required", () => {
    expect(azure.classifyCliError("Please run 'az login' to setup account.")).toBe("cli_auth")
  })

  it("detects not found", () => {
    expect(azure.classifyCliError("TF401180: The pull request does not exist")).toBe("not_found")
  })
})

describe("GitLabProvider.parseRemote", () => {
  it("parses an https remote", () => {
    expect(gitlab.parseRemote("https://gitlab.com/group/repo.git")).toEqual({
      host: "gitlab.com",
      owner: "group",
      repo: "repo",
    })
  })

  it("parses a subgroup https remote", () => {
    expect(gitlab.parseRemote("https://gitlab.com/group/subgroup/repo.git")).toEqual({
      host: "gitlab.com",
      owner: "group/subgroup",
      repo: "repo",
    })
  })

  it("parses an ssh remote", () => {
    expect(gitlab.parseRemote("git@gitlab.com:group/subgroup/repo.git")).toEqual({
      host: "gitlab.com",
      owner: "group/subgroup",
      repo: "repo",
    })
  })

  it("returns null for a non-GitLab remote", () => {
    expect(gitlab.parseRemote("https://github.com/owner/repo.git")).toBeNull()
  })
})

describe("AzureDevOpsProvider.parseRemote", () => {
  it("parses a modern https remote", () => {
    expect(azure.parseRemote("https://dev.azure.com/myorg/myproject/_git/myrepo")).toEqual({
      host: "dev.azure.com",
      owner: "myorg",
      project: "myproject",
      repo: "myrepo",
    })
  })

  it("parses an ssh remote", () => {
    expect(azure.parseRemote("git@ssh.dev.azure.com:v3/myorg/myproject/myrepo")).toEqual({
      host: "dev.azure.com",
      owner: "myorg",
      project: "myproject",
      repo: "myrepo",
    })
  })

  it("parses a legacy visualstudio.com remote", () => {
    expect(azure.parseRemote("https://myorg.visualstudio.com/myproject/_git/myrepo")).toEqual({
      host: "dev.azure.com",
      owner: "myorg",
      project: "myproject",
      repo: "myrepo",
    })
  })

  it("returns null for a non-Azure-DevOps remote", () => {
    expect(azure.parseRemote("https://gitlab.com/owner/repo.git")).toBeNull()
  })
})

describe("encodeThreadId / decodeThreadId", () => {
  it("round-trips a GitLab thread id", () => {
    const id = encodeThreadId("gitlab", "owner", "repo", "1", "discussion123", "456")
    expect(decodeThreadId(id)).toEqual({ providerId: "gitlab", parts: ["owner", "repo", "1", "discussion123", "456"] })
  })

  it("returns undefined for a plain GitHub GraphQL node id (no colons)", () => {
    expect(decodeThreadId("PRRT_kwDOA1b2Y84AbCdE")).toBeUndefined()
  })
})

describe("identifyPr", () => {
  it("identifies a GitHub PR URL without resolving to a Provider instance", () => {
    const found = identifyPr("https://github.com/owner/repo/pull/1")
    expect(found).toEqual({ provider: "github", ghRef: { owner: "owner", repo: "repo", number: 1 } })
  })

  it("identifies a GitLab merge request URL", () => {
    const found = identifyPr("https://gitlab.com/owner/repo/-/merge_requests/1")
    expect(found && found.provider !== "github" ? found.provider.id : undefined).toBe("gitlab")
  })

  it("identifies an Azure DevOps pull request URL", () => {
    const found = identifyPr("https://dev.azure.com/myorg/myproject/_git/myrepo/pullrequest/1")
    expect(found && found.provider !== "github" ? found.provider.id : undefined).toBe("azuredevops")
  })

  it("returns null for an unrecognized URL", () => {
    expect(identifyPr("https://example.test/not/a/pr")).toBeNull()
  })
})

describe("self-managed GitLab on a custom domain", () => {
  const url = "https://git.example.com/team/repo/-/merge_requests/4"

  it("recognizes a merge request URL by its path, not its hostname", () => {
    const found = identifyPr(url)
    expect(found && found.provider !== "github" ? [found.provider.id, found.ref] : undefined).toEqual([
      "gitlab",
      { host: "git.example.com", owner: "team", repo: "repo", number: 4 },
    ])
  })

  it("treats an unknown remote host as GitLab only when glab is signed in to it, and never asks for github.com", async () => {
    const found = identifyPr(url)
    const gitlab = found && found.provider !== "github" ? (found.provider as GitLabProvider) : undefined
    const asked: string[] = []
    const original = gitlab!.signedIn.bind(gitlab)
    gitlab!.signedIn = async (host) => {
      asked.push(host)
      return host === "git.example.com"
    }
    try {
      expect(await resolveRemote("git@git.example.com:team/repo.git", "/repo")).toMatchObject({
        base: { host: "git.example.com", owner: "team", repo: "repo" },
      })
      expect(await resolveRemote("https://ghe.example.com/team/repo.git", "/repo")).toBeUndefined()
      expect(await resolveRemote("https://github.com/team/repo.git", "/repo")).toBeUndefined()
      expect(asked).toEqual(["git.example.com", "ghe.example.com"])
    } finally {
      gitlab!.signedIn = original
    }
  })
})

describe("parseNonGitHubPrUrl", () => {
  it("resolves a GitLab merge request URL to the GitLab provider", () => {
    const found = parseNonGitHubPrUrl("https://gitlab.com/owner/repo/-/merge_requests/1")
    expect(found?.provider.id).toBe("gitlab")
    expect(found?.ref).toEqual({ host: "gitlab.com", owner: "owner", repo: "repo", number: 1 })
  })

  it("resolves an Azure DevOps pull request URL to the Azure DevOps provider", () => {
    const found = parseNonGitHubPrUrl("https://dev.azure.com/myorg/myproject/_git/myrepo/pullrequest/1")
    expect(found?.provider.id).toBe("azuredevops")
  })

  it("returns null for a GitHub PR URL (handled separately by git-import.ts)", () => {
    expect(parseNonGitHubPrUrl("https://github.com/owner/repo/pull/1")).toBeNull()
  })

  it("returns null for an unrecognized URL", () => {
    expect(parseNonGitHubPrUrl("https://example.test/not/a/pr")).toBeNull()
  })
})
