/**
 * Pure formatting helpers for the fleet island rows. Kept i18n-free: they
 * emit compact numeric strings ("2m14s") or pass through user content; all
 * translatable labels live in the components.
 */

import type { FleetSession, FleetStatus, IslandGeometry } from "./types"

/** Island geometry with every field defaulted — the shape callers can rely on. */
export const EMPTY_ISLAND_GEOMETRY: IslandGeometry = {
  topInset: 0,
  notchWidth: 0,
  fullscreen: false,
}

/** A logical-px length from an untrusted payload: finite and positive, else 0. */
function positiveLength(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Coerce an untrusted geometry payload into a total {@link IslandGeometry}.
 *
 * Both sources are untrusted in the same way: an event payload can be absent
 * mid-teardown, and the `island_resize` round-trip resolves against whatever a
 * test double or an older Rust build returns. A missing / non-finite / negative
 * inset means "no notch", and anything other than an explicit `true` means "not
 * full screen" — the conservative direction in both cases, since a wrong inset
 * hides the card under the camera housing and a wrong full-screen verdict makes
 * the island vanish.
 */
export function normalizeIslandGeometry(raw: unknown): IslandGeometry {
  const g = raw as Partial<IslandGeometry> | null | undefined
  return {
    topInset: positiveLength(g?.topInset),
    notchWidth: positiveLength(g?.notchWidth),
    fullscreen: g?.fullscreen === true,
  }
}

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

/**
 * Middle-ellipsis a filesystem path so a long cwd fits the detail row while
 * keeping the informative ends — the leading root and the trailing folder:
 * `/Users/x/very/deep/proj` → `/Users/x/…/proj`. Pure.
 */
export function formatCwdMiddle(cwd: string, max = 44): string {
  const flat = cwd.trim()
  if (flat.length <= max) return flat
  const keep = Math.max(1, max - 1) // room for the ellipsis
  const head = Math.ceil(keep / 2)
  const tail = Math.floor(keep / 2)
  return `${flat.slice(0, head)}…${flat.slice(flat.length - tail)}`
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
  detached: 5,
  ended: 6,
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

/** Severity of the fleet's attention need, for the island's breathing ring. */
export type AttentionSeverity = "none" | "input" | "permission"

/**
 * Highest attention severity across the fleet: a parked permission
 * (`permission`, the red ring) outranks a plan/input wait (`input`, amber);
 * `none` when nothing needs the user. Pure — permission always wins, so the
 * scan can return early. Mirrors `attentionCount`'s "needs you" set.
 */
export function attentionSeverity(sessions: readonly FleetSession[]): AttentionSeverity {
  let hasInput = false
  for (const s of sessions) {
    if (s.status === "waiting-permission" || s.pendingPermission) return "permission"
    if (s.status === "plan-pending" || s.status === "waiting-input") hasInput = true
  }
  return hasInput ? "input" : "none"
}

/**
 * Compact brand label for a raw model id, for the island's model chip:
 * `claude-opus-4-8` → "Opus", `claude-3-5-sonnet-20241022` → "Sonnet",
 * `gpt-5-codex` → "GPT-5-codex", `anthropic/claude-haiku-4-5` → "Haiku".
 * Model names are proper nouns shown verbatim (like the terminal label), so
 * this stays i18n-free; `null` when no model is known. Kept pure for tests.
 */
export function formatModelLabel(model: string | null | undefined): string | null {
  const raw = (model ?? "").trim()
  if (!raw) return null
  const lower = raw.toLowerCase()
  // Known families collapse to their short brand name regardless of the exact
  // versioned id — the common case for a Claude Code / OpenCode fleet.
  if (lower.includes("opus")) return "Opus"
  if (lower.includes("sonnet")) return "Sonnet"
  if (lower.includes("haiku")) return "Haiku"
  if (lower.includes("gemini")) return "Gemini"
  if (lower.includes("grok")) return "Grok"
  // Generic fallback: drop a provider prefix (`openai/…`), a trailing release
  // date (`-20241022` / `-2024-10-22`), uppercase a leading `gpt`, then cap.
  let label = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw
  label = label.replace(/-?\d{4}-\d{2}-\d{2}$/, "").replace(/-?\d{8}$/, "")
  label = label.replace(/^gpt/i, "GPT").trim() || raw
  return label.length > 22 ? `${label.slice(0, 21)}…` : label
}

/** Per-status counts for the island's expanded triage legend. */
export interface FleetStatusSummary {
  /** waiting-permission + plan-pending + waiting-input (the "needs you" bucket). */
  attention: number
  working: number
  idle: number
  detached: number
  ended: number
  total: number
}

/** Bucket a session list by status for the expanded breakdown legend. Pure. */
export function fleetStatusSummary(sessions: readonly FleetSession[]): FleetStatusSummary {
  const summary: FleetStatusSummary = {
    attention: 0,
    working: 0,
    idle: 0,
    detached: 0,
    ended: 0,
    total: sessions.length,
  }
  for (const s of sessions) {
    switch (s.status) {
      case "waiting-permission":
      case "plan-pending":
      case "waiting-input":
        summary.attention += 1
        break
      case "working":
        summary.working += 1
        break
      case "idle":
        summary.idle += 1
        break
      case "detached":
        summary.detached += 1
        break
      case "ended":
        summary.ended += 1
        break
    }
  }
  return summary
}
