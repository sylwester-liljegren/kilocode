#!/usr/bin/env bun
/**
 * Rebuild kilocode_change markers for one file by comparing it with the last
 * merged upstream version.
 *
 * Usage:
 *   bun run script/upstream/fix-kilocode-markers.ts packages/opencode/src/file.ts
 *   bun run script/upstream/fix-kilocode-markers.ts packages/opencode/src/file.ts --dry-run
 */

import { $ } from "bun"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { compareVersions, parseVersion, type VersionInfo } from "./utils/version"
import { isAncestor } from "./utils/git"
import { error, header, info, success, warn } from "./utils/logger"

interface Args {
  file?: string
  dryRun: boolean
  help: boolean
}

interface Text {
  lines: string[]
  eol: string
  final: boolean
}

interface Diff {
  lines: Set<number>
  deleted: number
}

interface Range {
  start: number
  end: number
}

type Style = "slash" | "hash" | "jsx"

const standalone = [
  /^\s*\/\/\s*kilocode_change\b.*$/,
  /^\s*#\s*kilocode_change\b.*$/,
  /^\s*\{?\s*\/\*\s*kilocode_change\b.*\*\/\}?\s*$/,
]
const suffix = [
  /\s+\/\/\s*kilocode_change\b.*$/,
  /\s+#\s*kilocode_change\b.*$/,
  /\s+\{\s*\/\*\s*kilocode_change\b.*\*\/\s*\}\s*$/,
]
const unsupported = new Set([".json", ".jsonc", ".lock", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico"])
const url = "https://github.com/anomalyco/opencode.git"
const exempt = ["script/upstream/"]

function usage() {
  console.log(`Usage: bun run script/upstream/fix-kilocode-markers.ts <repo-relative-file> [--dry-run]

Rebuilds kilocode_change markers by:
  1. Finding the newest upstream tag whose commit is already merged into HEAD.
  2. Comparing that upstream version of the file with the current working tree file.
  3. Removing existing kilocode_change markers and adding fresh markers around changed lines.

Options:
  --dry-run  Show what would change without writing the file.
  --help     Show this help message.`)
}

function args(): Args {
  const raw = process.argv.slice(2)
  return {
    file: raw.find((arg) => !arg.startsWith("--")),
    dryRun: raw.includes("--dry-run"),
    help: raw.includes("--help") || raw.includes("-h"),
  }
}

async function root() {
  return (await $`git rev-parse --show-toplevel`.text()).trim()
}

function normalize(root: string, file: string) {
  if (path.isAbsolute(file)) throw new Error("File must be relative to the repo root")
  if (file.includes("\0")) throw new Error("File path contains a null byte")

  const abs = path.resolve(root, file)
  const rel = path.relative(root, abs).replaceAll(path.sep, "/")

  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("File must stay inside the repo")
  return rel
}

function ext(file: string) {
  return path.extname(file).toLowerCase()
}

function supported(file: string) {
  const kind = ext(file)
  if (unsupported.has(kind)) return false
  return true
}

function annotates(file: string) {
  return !exempt.some((scope) => file.startsWith(scope))
}

function split(text: string): Text {
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  const final = text.endsWith("\n")
  const body = final ? text.slice(0, text.endsWith("\r\n") ? -2 : -1) : text
  return { lines: body ? body.split(/\r?\n/) : [], eol, final }
}

function join(text: Text) {
  return text.lines.join(text.eol) + (text.final ? text.eol : "")
}

function strip(line: string) {
  if (standalone.some((item) => item.test(line))) return null
  return suffix.reduce((current, item) => current.replace(item, ""), line)
}

function clean(text: string): Text {
  const parsed = split(text)
  const lines = parsed.lines.flatMap((line) => {
    const next = strip(line)
    if (next === null) return []
    return [next]
  })
  return { ...parsed, lines }
}

async function last(): Promise<VersionInfo> {
  const source = await remote()

  info(`Fetching upstream tags from ${source}...`)
  const fetch = await $`git fetch ${source} --tags --force`.quiet().nothrow()
  if (fetch.exitCode !== 0) throw new Error(`Failed to fetch upstream: ${fetch.stderr.toString()}`)

  const versions = await list(source)
  for (const version of versions) {
    if (await isAncestor(version.commit, "HEAD")) return version
  }

  throw new Error("Could not find a merged upstream tag in HEAD")
}

async function remote() {
  const result = await $`git remote get-url upstream`.quiet().nothrow()
  if (result.exitCode === 0) return "upstream"

  warn(`No 'upstream' remote found; using ${url}`)
  return url
}

async function list(source: string): Promise<VersionInfo[]> {
  const result = await $`git ls-remote --tags ${source}`.quiet().nothrow()
  if (result.exitCode !== 0) throw new Error(`Failed to list upstream tags: ${result.stderr.toString()}`)

  const found = new Map<string, string>()
  for (const line of result.stdout.toString().trim().split("\n")) {
    const match = line.match(/^([a-f0-9]+)\s+refs\/tags\/([^^]+)(\^\{\})?$/)
    if (!match) continue

    const commit = match[1]
    const tag = match[2]
    const peeled = Boolean(match[3])
    if (commit && tag && (peeled || !found.has(tag))) found.set(tag, commit)
  }

  return [...found]
    .flatMap(([tag, commit]) => {
      const version = parseVersion(tag)
      return version ? [{ version, tag, commit }] : []
    })
    .sort((a, b) => compareVersions(b.version, a.version))
}

async function upstream(ref: string, file: string) {
  const spec = `${ref}:${file}`
  const result = await $`git show ${spec}`.quiet().nothrow()
  if (result.exitCode === 0) return result.stdout.toString()

  const stderr = result.stderr.toString()
  if (stderr.includes("exists on disk") || stderr.includes("does not exist") || stderr.includes("Path")) return null
  throw new Error(`Failed to read ${file} from ${ref}: ${stderr}`)
}

function style(file: string): Style {
  const kind = ext(file)
  if ([".yml", ".yaml", ".toml", ".sh", ".bash", ".zsh"].includes(kind)) return "hash"
  return "slash"
}

function jsx(lines: string[], range: Range) {
  const first = lines[range.start]?.trim() ?? ""
  if (!first) return false
  if (first.startsWith("<")) return true
  if (first.startsWith("{")) {
    const prev =
      lines
        .slice(0, range.start)
        .findLast((line) => line.trim().length > 0)
        ?.trim() ?? ""
    if (prev.endsWith(">") || prev.endsWith(")") || prev.endsWith("(")) return true
  }
  return false
}

function block(mode: Style, pad: string) {
  if (mode === "hash") return { start: `${pad}# kilocode_change start`, end: `${pad}# kilocode_change end` }
  if (mode === "jsx") return { start: `${pad}{/* kilocode_change start */}`, end: `${pad}{/* kilocode_change end */}` }
  return { start: `${pad}// kilocode_change start`, end: `${pad}// kilocode_change end` }
}

function note(mode: Style) {
  if (mode === "hash") return " # kilocode_change"
  if (mode === "jsx") return " {/* kilocode_change */}"
  return " // kilocode_change"
}

function indent(line: string) {
  return line.match(/^\s*/)?.[0] ?? ""
}

function inline(file: string, lines: string[], range: Range, mode: Style) {
  if (mode === "hash") return true
  if (![".tsx", ".jsx"].includes(ext(file))) return true
  return !jsx(lines, range)
}

function ranges(nums: Set<number>): Range[] {
  const sorted = [...nums].sort((a, b) => a - b)
  return sorted.reduce<Range[]>((acc, num) => {
    const prev = acc.at(-1)
    if (prev && num === prev.end + 1) {
      prev.end = num
      return acc
    }
    acc.push({ start: num, end: num })
    return acc
  }, [])
}

function annotate(file: string, text: Text, found: Range[]) {
  const lines = [...text.lines]
  const base = style(file)

  for (const range of [...found].reverse()) {
    const mode = [".tsx", ".jsx"].includes(ext(file)) && jsx(text.lines, range) ? "jsx" : base
    if (range.start === range.end && inline(file, text.lines, range, mode)) {
      lines[range.start] = `${lines[range.start]}${note(mode)}`
      continue
    }

    const pad = indent(text.lines[range.start] ?? "")
    const pair = block(mode, pad)
    lines.splice(range.end + 1, 0, pair.end)
    lines.splice(range.start, 0, pair.start)
  }

  return join({ ...text, lines })
}

function fresh(file: string, text: Text) {
  const lines = [...text.lines]
  const mode = style(file)
  const line = mode === "hash" ? "# kilocode_change - new file" : "// kilocode_change - new file"
  const at = lines[0]?.startsWith("#!") ? 1 : 0
  lines.splice(at, 0, line)
  return join({ ...text, lines })
}

function patch(out: string): Diff {
  const lines = new Set<number>()
  const state = { next: 0, deleted: 0, added: 0, removed: 0 }
  const flush = () => {
    if (state.removed > 0 && state.added === 0) state.deleted += state.removed
    state.added = 0
    state.removed = 0
  }

  for (const line of out.split("\n")) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
    if (hunk) {
      flush()
      state.next = Number(hunk[1]) - 1
      continue
    }

    if (line.startsWith("+++") || line.startsWith("---")) continue
    if (line.startsWith("+")) {
      if (line.slice(1).trim()) lines.add(state.next)
      state.added++
      state.next++
      continue
    }
    if (line.startsWith("-")) {
      state.removed++
      continue
    }
    if (line.startsWith(" ")) state.next++
  }

  flush()
  return { lines, deleted: state.deleted }
}

async function changed(base: Text, head: Text): Promise<Diff> {
  const dir = await mkdtemp(path.join(tmpdir(), "kilo-markers-"))
  const left = path.join(dir, "upstream")
  const right = path.join(dir, "current")

  try {
    await Bun.write(left, join({ ...base, eol: "\n" }))
    await Bun.write(right, join({ ...head, eol: "\n" }))

    const result = await $`git diff --no-index --no-ext-diff --unified=0 -- ${left} ${right}`.quiet().nothrow()
    if (result.exitCode === 0) return { lines: new Set(), deleted: 0 }
    if (result.exitCode === 1) return patch(result.stdout.toString())
    throw new Error(result.stderr.toString())
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function main() {
  const opts = args()
  if (opts.help) {
    usage()
    return
  }
  if (!opts.file) {
    usage()
    process.exit(1)
  }

  const top = await root()
  process.chdir(top)

  const file = normalize(top, opts.file)
  if (!supported(file)) throw new Error(`Cannot safely add comment markers to ${file}`)

  const abs = path.join(top, file)
  const current = await Bun.file(abs).text()
  if (current.includes("\0")) throw new Error(`${file} appears to be binary`)

  header("Fix kilocode_change markers")

  const version = await last()
  success(`Last merged upstream: ${version.tag} (${version.commit.slice(0, 8)})`)

  const base = await upstream(version.commit, file)
  const head = clean(current)
  const diff = base === null ? null : await changed(clean(base), head)
  const found = ranges(diff?.lines ?? new Set())
  const next = base === null ? fresh(file, head) : annotate(file, head, found)

  if (base === null && annotates(file)) warn(`${file} does not exist upstream; marked as a new Kilo file`)
  if (base === null && !annotates(file)) warn(`${file} does not exist upstream`)
  if (diff && diff.deleted > 0)
    warn(`${diff.deleted} upstream-only deleted line(s) cannot be annotated in the current file`)
  if (!annotates(file)) warn(`${file} is exempt from annotation checks; this command still reports differences`)
  if (!annotates(file)) {
    success(`${file} differs from ${version.tag} in ${found.length} range(s)`)
    return
  }

  if (next === current) {
    success(`${file} already has normalized kilocode_change markers`)
    return
  }

  if (opts.dryRun) {
    info(`[DRY-RUN] Would update ${file}`)
    return
  }

  await Bun.write(abs, next)
  success(`Updated ${file}`)
}

main().catch((err) => {
  error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
