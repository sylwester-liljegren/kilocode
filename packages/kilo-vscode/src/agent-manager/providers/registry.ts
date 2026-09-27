import { parsePRUrl } from "../git-import"
import { AzureDevOpsProvider } from "./azuredevops"
import { GitLabProvider } from "./gitlab"
import type { PrRef, Provider } from "./provider"

/**
 * GitHub is intentionally not in this list — it keeps its own dedicated, long-tested code path in
 * `gh.ts`/`git-import.ts`/`WorktreeManager.ts`. This registry only covers the providers added
 * alongside it, so a pasted GitHub PR URL is tried first and never reaches here.
 */
const cache: { gitlab?: GitLabProvider; list?: Provider[] } = {}

/**
 * Built on first use, not at module load: the providers import PR helpers that (through
 * `pr/PRActions.ts`) import this registry back, so constructing them eagerly would hit the classes
 * before that cycle has finished initializing.
 */
function providers(): Provider[] {
  cache.gitlab ??= new GitLabProvider()
  cache.list ??= [cache.gitlab, new AzureDevOpsProvider()]
  return cache.list
}

/** Try each non-GitHub provider's URL parser in turn, returning the first match. */
export function parseNonGitHubPrUrl(url: string): { provider: Provider; ref: PrRef } | null {
  for (const provider of providers()) {
    const ref = provider.parsePrUrl(url)
    if (ref) return { provider, ref }
  }
  return null
}

/**
 * Identifies which provider a PR/MR URL belongs to, GitHub included. Consumers that already have a
 * dedicated GitHub code path (review, merge, suggestion actions) branch on `provider === "github"`
 * and keep using it unchanged; only the two literal cases here dispatch into the `Provider` objects.
 */
export function identifyPr(
  url: string,
):
  | { provider: "github"; ghRef: { owner: string; repo: string; number: number } }
  | { provider: Provider; ref: PrRef }
  | null {
  const gh = parsePRUrl(url)
  if (gh) return { provider: "github", ghRef: gh }
  const found = parseNonGitHubPrUrl(url)
  return found ? { provider: found.provider, ref: found.ref } : null
}

/** Looks up a non-GitHub provider by its `id`, for decoding an opaque thread id back into a provider. */
export function providerById(id: string): Provider | undefined {
  return providers().find((provider) => provider.id === id)
}

/** Parses `git remote get-url origin` into the provider that owns it, or `undefined` for GitHub/unrecognized. */
function detectProviderFromRemote(remoteUrl: string): { provider: Provider; base: Omit<PrRef, "number"> } | undefined {
  for (const provider of providers()) {
    const base = provider.parseRemote(remoteUrl)
    if (base) return { provider, base }
  }
  return undefined
}

/**
 * {@link detectProviderFromRemote}, plus custom-domain GitLab: a host that isn't github.com and that
 * `glab` is signed in to. Callers cache the result; it costs one `glab auth status` per unknown host.
 */
export async function resolveRemote(
  remoteUrl: string,
  root: string,
): Promise<{ provider: Provider; base: Omit<PrRef, "number"> } | undefined> {
  const found = detectProviderFromRemote(remoteUrl)
  if (found) return found
  providers()
  const gitlab = cache.gitlab!
  const base = gitlab.parseRemote(remoteUrl, true)
  if (!base || /(^|\.)github\.com$/i.test(base.host)) return undefined
  return (await gitlab.signedIn(base.host, root)) ? { provider: gitlab, base } : undefined
}
