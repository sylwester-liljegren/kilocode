#!/usr/bin/env bun
/**
 * Find files whose drift from the last merged upstream is insignificant and
 * (optionally) reset them back to upstream.
 *
 * Starts from `git diff --name-only <upstream-commit>..HEAD` to pre-filter the
 * working tree, then classifies each candidate:
 *
 *   - identical           : local bytes already match transformed upstream
 *   - markers-only        : only diff is kilocode_change markers wrapping
 *                           identical code (stale markers)
 *   - whitespace-only     : only diff is whitespace
 *   - small-diff          : <= --review-limit non-marker diff lines
 *   - large-diff          : > --review-limit non-marker diff lines (skipped)
 *   - upstream-missing    : file does not exist upstream (kilo-only, skipped)
 *   - local-missing       : file tracked by git but missing locally (skipped)
 *   - binary-identical    : binary file already matches (skipped)
 *   - binary-diff         : binary file differs (skipped; use reset-to-upstream.ts
 *                           per file if you want to reset binaries)
 *
 * markers-only, whitespace-only, and small-diff buckets are auto-reset unless
 * --dry-run is passed. A markdown summary is printed to stdout at the end so
 * you can review what happened and spot-check the resulting `git diff`.
 *
 * Usage:
 *   bun run script/upstream/find-reset-candidates.ts
 *   bun run script/upstream/find-reset-candidates.ts packages/opencode/src/agent
 *   bun run script/upstream/find-reset-candidates.ts --dry-run --review-limit 3
 */

import { $ } from "bun"
import { error, header, info, success, warn } from "./utils/logger"
import { classifyDrift, resetFile, type Bucket, type ClassifyResult } from "./utils/reset"
import { last, normalize, root } from "./utils/upstream"

interface Args {
  scope?: string
  reviewLimit: number
  dryRun: boolean
  concurrency: number
  help: boolean
}

interface Entry extends ClassifyResult {
  file: string
  reset?: boolean
}

const KILO_ONLY_PATHS = [
  "packages/kilo-docs",
  "packages/kilo-gateway",
  "packages/kilo-i18n",
  "packages/kilo-indexing",
  "packages/kilo-jetbrains",
  "packages/kilo-telemetry",
  "packages/kilo-ui",
  "packages/kilo-vscode",
  "packages/opencode/src/kilocode",
  "packages/opencode/test/kilocode",
  "script/upstream",
]

const RESET_BUCKETS = new Set<Bucket>(["markers-only", "whitespace-only", "small-diff"])

const BUCKET_ORDER: Bucket[] = [
  "markers-only",
  "whitespace-only",
  "small-diff",
  "large-diff",
  "identical",
  "binary-diff",
  "binary-identical",
  "upstream-missing",
  "local-missing",
]

function usage() {
  console.log(`Usage: bun run script/upstream/find-reset-candidates.ts [path] [options]

Arguments:
  path                     Optional repo-relative subdirectory to scope to.
                           Defaults to all tracked shared paths.

Options:
  --review-limit <n>       Max non-marker diff lines that still auto-resets
                           (default: 5).
  --dry-run                Classify and report only; do not write any files.
  --concurrency <n>        Parallel classifications (default: 8).
  --help                   Show this help message.`)
}

function args(): Args {
  const raw = process.argv.slice(2)
  const skip = new Set<number>()

  const flagValue = (names: string[]) => {
    const idx = raw.findIndex((a) => names.includes(a) || names.some((n) => a.startsWith(`${n}=`)))
    if (idx === -1) return undefined
    skip.add(idx)
    const arg = raw[idx]
    if (arg.includes("=")) return arg.slice(arg.indexOf("=") + 1)
    skip.add(idx + 1)
    return raw[idx + 1]
  }

  const reviewRaw = flagValue(["--review-limit"])
  const reviewLimit = reviewRaw === undefined ? 5 : Number(reviewRaw)
  if (!Number.isFinite(reviewLimit) || reviewLimit < 0) {
    throw new Error("--review-limit requires a non-negative number")
  }

  const concurrencyRaw = flagValue(["--concurrency"])
  const concurrency = concurrencyRaw === undefined ? 8 : Number(concurrencyRaw)
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("--concurrency requires a positive integer")
  }

  const positional = raw.filter((a, i) => !skip.has(i) && !a.startsWith("--"))
  if (positional.length > 1) throw new Error(`Unexpected extra arguments: ${positional.slice(1).join(" ")}`)

  return {
    scope: positional[0],
    reviewLimit,
    concurrency,
    dryRun: raw.includes("--dry-run"),
    help: raw.includes("--help") || raw.includes("-h"),
  }
}

async function candidates(commit: string, scope: string | undefined, top: string): Promise<string[]> {
  const pathspecs = [scope ?? ".", ...KILO_ONLY_PATHS.map((p) => `:(exclude)${p}`)]
  const result = await $`git diff --name-only ${commit}..HEAD -- ${pathspecs}`.cwd(top).quiet().nothrow()
  if (result.exitCode !== 0) {
    throw new Error(`Failed to list candidate files: ${result.stderr.toString()}`)
  }
  return result.stdout
    .toString()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

async function concurrent<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length })
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const idx = next++
      results[idx] = await fn(items[idx], idx)
    }
  }
  const workers = Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, worker)
  await Promise.all(workers)
  return results
}

function group(entries: Entry[]): Map<Bucket, Entry[]> {
  const out = new Map<Bucket, Entry[]>()
  for (const entry of entries) {
    const bucket = out.get(entry.bucket) ?? []
    bucket.push(entry)
    out.set(entry.bucket, bucket)
  }
  for (const bucket of out.values()) bucket.sort((a, b) => a.file.localeCompare(b.file))
  return out
}

function describe(bucket: Bucket, count: number, dryRun: boolean): { label: string; action: string } {
  if (bucket === "markers-only") return { label: `markers-only (${count})`, action: dryRun ? "would reset" : "reset" }
  if (bucket === "whitespace-only")
    return { label: `whitespace-only (${count})`, action: dryRun ? "would reset" : "reset" }
  if (bucket === "small-diff") return { label: `small-diff (${count})`, action: dryRun ? "would reset" : "reset" }
  if (bucket === "large-diff") return { label: `large-diff (${count})`, action: "skipped" }
  if (bucket === "identical") return { label: `identical (${count})`, action: "nothing to do" }
  if (bucket === "binary-diff") return { label: `binary-diff (${count})`, action: "skipped" }
  if (bucket === "binary-identical") return { label: `binary-identical (${count})`, action: "nothing to do" }
  if (bucket === "upstream-missing") return { label: `upstream-missing (${count})`, action: "skipped" }
  return { label: `local-missing (${count})`, action: "skipped" }
}

function report(entries: Entry[], dryRun: boolean, tag: string, commit: string, scope: string, limit: number) {
  const grouped = group(entries)
  const lines: string[] = []

  lines.push(`# Reset-to-upstream candidate report`)
  lines.push("")
  lines.push(`- Last merged upstream: **${tag}** (\`${commit.slice(0, 8)}\`)`)
  lines.push(`- Scope: \`${scope}\``)
  lines.push(`- Review limit: ${limit} non-marker diff line(s)`)
  lines.push(`- Mode: ${dryRun ? "dry-run (no writes)" : "auto-apply"}`)
  lines.push(`- Total candidates: ${entries.length}`)
  lines.push("")

  lines.push(`## Summary`)
  lines.push("")
  lines.push(`| Bucket | Count | Action |`)
  lines.push(`|---|---|---|`)
  for (const bucket of BUCKET_ORDER) {
    const items = grouped.get(bucket) ?? []
    if (items.length === 0) continue
    const info = describe(bucket, items.length, dryRun)
    lines.push(`| ${bucket} | ${items.length} | ${info.action} |`)
  }
  lines.push("")

  for (const bucket of BUCKET_ORDER) {
    const items = grouped.get(bucket) ?? []
    if (items.length === 0) continue
    const info = describe(bucket, items.length, dryRun)
    lines.push(`## ${info.label} — ${info.action}`)
    lines.push("")
    for (const entry of items) {
      const suffix = entry.lines !== undefined ? ` (${entry.lines} line${entry.lines === 1 ? "" : "s"})` : ""
      const note = entry.reset === false ? " [reset failed]" : ""
      lines.push(`- \`${entry.file}\`${suffix}${note}`)
    }
    lines.push("")
  }

  return lines.join("\n")
}

async function main() {
  const opts = args()
  if (opts.help) {
    usage()
    return
  }

  const top = await root()
  process.chdir(top)

  const scope = opts.scope ? normalize(top, opts.scope) : undefined

  header("Find reset-to-upstream candidates")

  const version = await last()
  success(`Last merged upstream: ${version.tag} (${version.commit.slice(0, 8)})`)

  info(`Scope: ${scope ?? "(all shared paths)"}`)
  info(`Review limit: ${opts.reviewLimit} non-marker diff line(s)`)
  info(`Mode: ${opts.dryRun ? "dry-run" : "auto-apply"}`)

  const files = await candidates(version.commit, scope, top)
  if (files.length === 0) {
    success("No files differ from upstream in scope. Nothing to do.")
    return
  }
  info(`Candidate files: ${files.length}`)

  const entries = await concurrent(files, opts.concurrency, async (file, i) => {
    const result = await classifyDrift({
      root: top,
      file,
      commit: version.commit,
      reviewLimit: opts.reviewLimit,
    })
    if ((i + 1) % 25 === 0 || i === files.length - 1) {
      info(`Classified ${i + 1}/${files.length}`)
    }
    return { file, ...result } as Entry
  })

  if (!opts.dryRun) {
    const resets = entries.filter((e) => RESET_BUCKETS.has(e.bucket))
    if (resets.length > 0) info(`Resetting ${resets.length} file(s) to upstream...`)
    await concurrent(resets, opts.concurrency, async (entry) => {
      const result = await resetFile({ root: top, file: entry.file, commit: version.commit })
      entry.reset = result.action !== "skipped"
      if (result.action === "skipped") warn(`Skipped ${entry.file}: ${result.reason ?? "unknown"}`)
    })
  }

  console.log("")
  console.log(report(entries, opts.dryRun, version.tag, version.commit, scope ?? "(all shared paths)", opts.reviewLimit))
}

main().catch((err) => {
  error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
