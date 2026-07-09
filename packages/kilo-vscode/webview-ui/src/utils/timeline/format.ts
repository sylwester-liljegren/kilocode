/** Formatting helpers for timeline bar metadata (tooltip + details dialog). */

import type { TimelineTimestamp } from "./metadata"

const compactTime = new Intl.DateTimeFormat(undefined, { timeStyle: "medium" })
const compactDateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })
const fullDateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" })

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** Compact form for the hover tooltip: time-only for today, short date+time otherwise. */
export function formatCompactTimestamp(ts: TimelineTimestamp): string {
  const date = new Date(ts.value)
  const text = sameDay(date, new Date()) ? compactTime.format(date) : compactDateTime.format(date)
  return ts.approx ? `~${text}` : text
}

/** Full absolute form for the details dialog. */
export function formatFullTimestamp(ts: TimelineTimestamp): string {
  const text = fullDateTime.format(new Date(ts.value))
  return ts.approx ? `~${text}` : text
}

export function formatDuration(ts: TimelineTimestamp): string | undefined {
  if (ts.end === undefined) return undefined
  const ms = Math.max(0, ts.end - ts.value)
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`
}

export function formatCompactCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(Math.round(value))
}

export function formatCost(value: number): string {
  if (value <= 0) return "$0"
  if (value < 0.000001) return "<$0.000001"
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(value)
}
