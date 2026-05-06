#!/usr/bin/env bun

/**
 * Guards against accidentally inheriting workflows from upstream opencode.
 *
 * We regularly merge upstream. When upstream adds a new workflow under
 * `.github/workflows/`, it silently starts running in our CI unless we
 * explicitly review and accept it. This check makes that decision explicit:
 * the list of allowed workflows is hardcoded below, and any drift (added or
 * removed file in `.github/workflows/` or `.github/workflows/disabled/`) fails
 * CI until the list is updated deliberately.
 *
 * To accept a new workflow: add its filename to `active` (or `disabled`).
 * To drop one: remove its filename from the list.
 */

import { readdirSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "..")
const DIR = path.join(ROOT, ".github", "workflows")

// Workflows we have deliberately accepted into CI. Sort alphabetically.
const active = new Set([
  "auto-docs.yml",
  "beta.yml",
  "check-md-table-padding.yml",
  "check-opencode-annotations.yml",
  "check-org-member.yml",
  "close-issues.yml",
  "close-stale-prs.yml",
  "containers.yml",
  "docs-build.yml",
  "docs-check-links.yml",
  "duplicate-issues.yml",
  "generate.yml",
  "nix-eval.yml",
  "nix-hashes.yml",
  "publish.yml",
  "smoke-test.yml",
  "source-check-links.yml",
  "test-vscode.yml",
  "test.yml",
  "triage.yml",
  "typecheck.yml",
  "visual-regression.yml",
  "watch-opencode-releases.yml",
])

// Workflows we have explicitly disabled. Kept here so that upstream additions
// to `.github/workflows/disabled/` also require a manual review.
const disabled = new Set([
  "compliance-close.yml.disabled",
  "daily-issues-recap.yml.disabled",
  "daily-pr-recap.yml.disabled",
  "kilo.yml.disabled",
  "nix-desktop.yml.disabled",
  "notify-discord.yml.disabled",
  "pr-management.yml.disabled",
  "pr-standards.yml.disabled",
  "publish-github-action.yml.disabled",
  "release-github-action.yml.disabled",
  "review.yml.disabled",
  "stats.yml.disabled",
  "storybook.yml.disabled",
  "sync-zed-extension.yml.disabled",
])

function diff(expected: Set<string>, actual: Set<string>, label: string) {
  const missing = [...expected].filter((f) => !actual.has(f)).sort()
  const extra = [...actual].filter((f) => !expected.has(f)).sort()
  const errs: string[] = []
  for (const f of extra) {
    errs.push(
      `unexpected ${label} workflow: ${f} — if this was added intentionally, add it to script/check-workflows.ts`,
    )
  }
  for (const f of missing) {
    errs.push(
      `expected ${label} workflow not found: ${f} — if this was removed intentionally, remove it from script/check-workflows.ts`,
    )
  }
  return errs
}

const actualActive = new Set(readdirSync(DIR).filter((f) => f.endsWith(".yml")))
const actualDisabled = new Set(readdirSync(path.join(DIR, "disabled")).filter((f) => f.endsWith(".disabled")))

const errs = [...diff(active, actualActive, "active"), ...diff(disabled, actualDisabled, "disabled")]

if (errs.length === 0) {
  console.log(`check-workflows: ok (${actualActive.size} active, ${actualDisabled.size} disabled).`)
  process.exit(0)
}

for (const e of errs) console.error(e)
console.error("")
console.error(`Found ${errs.length} workflow drift issue(s).`)
console.error("This guard prevents upstream-merged workflows from silently running in our CI.")
process.exit(1)
