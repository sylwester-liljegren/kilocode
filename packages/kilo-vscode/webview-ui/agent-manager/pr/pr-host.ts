import { PR_REACTION_CONTENT, type PRReactionContent } from "./pr-types"

export type PRHost = "github" | "gitlab" | "azuredevops"

/**
 * Which service a PR belongs to, from its URL path rather than its hostname, so self-managed
 * GitLab and legacy `*.visualstudio.com` Azure DevOps URLs are recognized too.
 */
export function prHost(url?: string): PRHost {
  if (!url) return "github"
  if (/\/-\/merge_requests\/\d+/.test(url)) return "gitlab"
  if (/\/_git\/[^/]+\/pullrequest\/\d+/i.test(url)) return "azuredevops"
  return "github"
}

const CHOICES: Record<PRHost, readonly PRReactionContent[]> = {
  github: PR_REACTION_CONTENT,
  // GitLab award emoji have no "confused" equivalent.
  gitlab: PR_REACTION_CONTENT.filter((content) => content !== "CONFUSED"),
  // Azure DevOps comments only support an untyped "like".
  azuredevops: ["THUMBS_UP"],
}

export function reactionChoices(url?: string): readonly PRReactionContent[] {
  return CHOICES[prHost(url)]
}

const OPEN: Record<PRHost, string> = {
  github: "agentManager.pr.comment.openOnGitHub",
  gitlab: "agentManager.pr.comment.openOnGitLab",
  azuredevops: "agentManager.pr.comment.openOnAzureDevOps",
}

export function openLabel(url?: string): string {
  return OPEN[prHost(url)]
}
