/**
 * Pure formatting helpers for the fleet island rows. Kept i18n-free: they
 * emit compact numeric strings ("2m14s") or pass through user content; all
 * translatable labels live in the components.
 */

import type { FleetSession, FleetStatus } from "./types"

/**
 * Compact elapsed rendering matching the reference design:
 * `<1m` → "42s", `<1h` → "2m14s", `≥1h` → "1h37m".
 */
export function formatElapsed(fromMs: number, nowMs: number): string {
  const totalSec = Math.max(0, Math.floor((nowMs - fromMs) / 1000))
  const hours = Math.floor(totalSec / 3600)
  const minutes = Math.floor((totalSec % 3600) / 60)
  const seconds = totalSec % 60
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`
  return `${seconds}s`
}

/** Single-line truncation with an ellipsis, grapheme-safe enough for UI. */
export function truncateLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/** "Bash: pnpm test" — tool name plus its compact detail when present. */
export function activityLine(session: FleetSession): string | null {
  const activity = session.activity
  if (!activity) return null
  return activity.detail
    ? `${activity.toolName}(${truncateLine(activity.detail, 120)})`
    : activity.toolName
}

/**
 * Row sort: attention-needing sessions first (permission > plan > input),
 * then working, then idle/ended; ties by recency. The Rust snapshot arrives
 * recency-sorted; this re-ranks for the island's "what needs me" reading.
 */
const STATUS_RANK: Record<FleetStatus, number> = {
  "waiting-permission": 0,
  "plan-pending": 1,
  "waiting-input": 2,
  working: 3,
  idle: 4,
  ended: 5,
}

export function sortForIsland(sessions: readonly FleetSession[]): FleetSession[] {
  return [...sessions].sort((a, b) => {
    const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status]
    if (rank !== 0) return rank
    return b.lastEventAt - a.lastEventAt
  })
}

/** True when any session needs the user's attention (drives the pill badge). */
export function attentionCount(sessions: readonly FleetSession[]): number {
  return sessions.filter(
    (s) =>
      s.status === "waiting-permission" ||
      s.status === "plan-pending" ||
      s.status === "waiting-input"
  ).length
}
