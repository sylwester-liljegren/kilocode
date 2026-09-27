import { randomUUID } from "node:crypto"
import type { PRDiffSnapshot, PRFile } from "../../shared/pr-comment-actions"
import { oid } from "../../shared/pr-comment-preview"
import { execWithShellEnv } from "../shell-env"
import type { PrRef, Provider } from "../providers/provider"

/**
 * Builds the same `PRDiffSnapshot` shape GitHub's `pr/review-actions.ts` produces from its REST
 * files API, but from a local `git diff` — GitLab and Azure DevOps worktrees already have
 * `baseRefOid`/`headRefOid` fetched locally (from import or status polling), so there is no need to
 * replicate either platform's own diff API to load a review.
 */

const DIFF = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--find-renames", "-l1000", "--no-relative"]
const MAX_FILES = 3000
const MAX_BYTES = 4 * 1024 * 1024
const DEADLINE = 15_000

const STATUS: Record<string, string> = { A: "added", M: "modified", D: "removed", T: "changed", C: "copied" }

function status(code: string): string {
  if (code.startsWith("R")) return "renamed"
  return STATUS[code] ?? "changed"
}

interface Entry {
  status: string
  before?: string
  after: string
}

function parseNameStatus(text: string): Entry[] {
  const values = text.split("\0")
  if (values.pop() !== "") throw new Error("Incomplete pull request diff.")
  const entries: Entry[] = []
  for (let index = 0; index < values.length; ) {
    const code = values.at(index++) ?? ""
    if (!/^(?:[AMDT]|R\d+)$/.test(code)) throw new Error("Invalid pull request diff status.")
    const before = values.at(index++)
    const after = code.startsWith("R") ? values.at(index++) : before
    if (!before || !after) throw new Error("Invalid pull request diff path.")
    entries.push({ status: status(code), before: before === after ? undefined : before, after })
  }
  return entries
}

async function git(root: string, args: string[], deadline: number): Promise<string> {
  const { stdout } = await execWithShellEnv("git", ["--no-optional-locks", "--no-replace-objects", ...args], {
    cwd: root,
    timeout: Math.max(1, Math.min(10_000, deadline - Date.now())),
    maxBuffer: MAX_BYTES,
  })
  return stdout
}

export async function loadProviderDiff(
  provider: Provider,
  ref: PrRef,
  root: string,
): Promise<{ baseRefOid: string; headRefOid: string; snapshot: PRDiffSnapshot }> {
  const { baseRefOid, headRefOid } = await provider.fetchDiffRefs(ref, root)
  if (!oid(baseRefOid) || !oid(headRefOid)) throw new Error("Invalid pull request revision.")
  const deadline = Date.now() + DEADLINE

  const base = (await git(root, ["merge-base", "--all", baseRefOid, headRefOid], deadline)).trim()
  if (!oid(base)) throw new Error("Could not compute a merge base for this pull request.")

  const entries = parseNameStatus(await git(root, [...DIFF, "--name-status", "-z", base, headRefOid, "--"], deadline))
  if (entries.length > MAX_FILES) throw new Error("This pull request has too many changed files to review safely here.")

  const files: PRFile[] = []
  let size = 0
  for (const entry of entries) {
    const paths = entry.before ? [entry.before, entry.after] : [entry.after]
    const patch = await git(
      root,
      [
        ...DIFF,
        "--unified=6",
        "--inter-hunk-context=0",
        base,
        headRefOid,
        "--",
        ...paths.map((p) => `:(top,literal)${p}`),
      ],
      deadline,
    )
    size += entry.after.length + patch.length
    if (size > MAX_BYTES) throw new Error("This pull request diff is too large to review safely here.")
    files.push({ path: entry.after, previousPath: entry.before, status: entry.status, patch: patch || undefined })
  }

  return { baseRefOid, headRefOid, snapshot: { id: randomUUID(), head: headRefOid, files } }
}
