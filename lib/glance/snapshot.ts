/**
 * `GlanceSnapshotV1`: the one object every glance consumer reads (ADR-0225 §7).
 *
 * The main window builds it; the tray panel window, and from later phases the
 * Capacity Dock and paired phones, render it and nothing else. That is what
 * keeps those surfaces away from Dexie, stores and every control plane.
 *
 * The shape enforces the rule ADR-0165 set for the usage glance and this ADR
 * extends to every slice: numbers, ids, enums, timestamps and short, capped
 * labels the user already sees elsewhere (a conversation title, a scheduled
 * task's name). No message text, no prompt, no file path, no command line, no
 * tool argument. Every slice carries its own `updatedAt` so a consumer can say
 * how old each part is rather than pretending the whole object is fresh.
 */

import type { TrayStateSnapshot } from "@/lib/tray/types"
import type {
  GlanceActivityRange,
  GlancePanelSettings,
  GlanceUsageScope,
} from "@/types/glance/layout"
import type { LimitsMeterKind } from "@/types/subscription"

export const GLANCE_SNAPSHOT_VERSION = 1

/* ── Fleet (summary of the island projection) ────────────────────────── */

/** Coarse state of one Fleet row. `awaiting` is the island's `blocked`. */
export type GlanceFleetState = "working" | "awaiting" | "failed" | "done" | "idle" | "stale"

export interface GlanceFleetRow {
  /** The island row id (`taskIdentity(owner)`), so a click can pin it there. */
  id: string
  /** Redacted, capped title, as the island shows it. */
  title: string
  /** Agent id (`claude-code`, `codex`, `cognia`, …) or null. */
  agent: string | null
  /** Configured display name for generic agents. */
  agentLabel: string | null
  state: GlanceFleetState
  /** `fleet.island.state.*` key, when the island has one. */
  statusKey: string | null
  startedAt: number
  updatedAt: number
  waitingSince: number | null
}

export interface GlanceFleetSlice {
  updatedAt: number
  counts: { working: number; awaiting: number; failed: number }
  /** Every row the island holds, so a consumer can say "N more". */
  total: number
  /** Rows by island priority, capped at {@link GLANCE_FLEET_MAX_ROWS}. */
  rows: GlanceFleetRow[]
}

export const GLANCE_FLEET_MAX_ROWS = 8

/* ── Usage ───────────────────────────────────────────────────────────── */

export interface GlanceUsageTotals {
  /** Fresh input + output tokens, the same definition the usage glance uses. */
  tokens: number
  /** Sum over priced turns only. Never folds an unknown in as zero. */
  knownCostUsd: number
  turns: number
}

export interface GlanceUsageDay {
  /** Local day, `YYYY-MM-DD`. */
  day: string
  tokens: number
  knownCostUsd: number
  turns: number
}

export interface GlanceUsageLeader {
  /** Provider or model id; the renderer translates. */
  id: string
  tokens: number
  knownCostUsd: number
}

export interface GlanceUsageSlice {
  updatedAt: number
  scope: GlanceUsageScope
  showSpend: boolean
  /** True when the workspace filter narrowed the rows. */
  workspaceFiltered: boolean
  freshness: "fresh" | "stale" | "partial"
  today: GlanceUsageTotals
  week: GlanceUsageTotals
  month: GlanceUsageTotals
  /** Turns in the 30-day window with no known price. */
  unpricedTurns: number
  /** Last 7 local days, oldest first, zero-filled. */
  sparkline: GlanceUsageDay[]
  topModel: GlanceUsageLeader | null
  /** Top providers by tokens, with their share of known tokens. */
  providers: Array<GlanceUsageLeader & { share: number }>
  budget: { ratio: number; period: "day" | "month" | null; blocked: boolean } | null
}

/* ── Quota ───────────────────────────────────────────────────────────── */

/**
 * One vocabulary for every quota row (ADR-0225 §5):
 *
 * - `ok` / `warn` / `exhausted`: a fresh reading, by its worst meter.
 * - `error`: the last query failed. Meters are the last good reading, if any.
 * - `stale`: the newest reading is older than the freshness window.
 * - `refreshing`: a query is in flight and there is no reading yet.
 * - `disabled`: the account is in Cognia's vault but quota queries are off;
 *   enabling is a settings toggle, safe to do from the panel.
 * - `discovered`: a login exists on this machine but is not in the vault;
 *   adopting it writes credentials, so it routes to subscription settings.
 */
export type GlanceQuotaState =
  "ok" | "warn" | "exhausted" | "error" | "stale" | "refreshing" | "disabled" | "discovered"

export interface GlanceQuotaWindow {
  id: string
  labelKey: string | null
  label: string | null
  kind: LimitsMeterKind
  /** 0-100, the share USED (the convention of the providers' own endpoints). */
  usedPct: number | null
  resetAt: number | null
  remaining: number | null
  unit: string | null
  currency: string | null
  severity: "ok" | "warn" | "crit" | "exceeded" | "unknown"
}

export interface GlanceQuotaSource {
  /** `${provider}:${accountId}` for vault accounts, `discovered:${provider}` otherwise. */
  key: string
  provider: string
  accountId: string | null
  accountLabel: string | null
  state: GlanceQuotaState
  windows: GlanceQuotaWindow[]
  /** When the meters shown were read. Null when there is no reading. */
  fetchedAt: number | null
  /** Redacted, capped message for `error`. */
  error: string | null
}

export interface GlanceQuotaSlice {
  updatedAt: number
  refreshing: boolean
  sources: GlanceQuotaSource[]
}

/* ── Agenda (schedule · notifications · connectivity) ────────────────── */

export interface GlanceAgendaSlice {
  updatedAt: number
  /** False when scheduled tasks run on another host, so this one has no agenda. */
  schedulerLocal: boolean
  nextRun: {
    /** Unified scheduler id, the `?item=` the scheduler page selects. */
    itemId: string
    name: string
    at: number
  } | null
  lastOutcome: { ok: boolean; at: number; name: string } | null
  unread: number
  latestUnreadTitle: string | null
  connectivity: {
    state: "remote" | "unpaired" | "paired" | "offline"
    connected: number
    total: number
    lastContactAt: number | null
  }
}

/* ── Activity ────────────────────────────────────────────────────────── */

export interface GlanceActivityDay {
  day: string
  tokens: number
  /** 0 (none) to 4, quantiles of the active days in range. */
  level: 0 | 1 | 2 | 3 | 4
}

export interface GlanceActivitySlice {
  updatedAt: number
  range: GlanceActivityRange
  /** Oldest first, one entry per local day, zero-filled, ending today. */
  days: GlanceActivityDay[]
  activeDays: number
  currentStreak: number
  longestStreak: number
  peakHour: number | null
}

/* ── Recents ─────────────────────────────────────────────────────────── */

export interface GlanceRecentsSlice {
  updatedAt: number
  rows: Array<{ id: string; title: string; updatedAt: number }>
}

export const GLANCE_RECENTS_MAX_ROWS = 5

/* ── Pet ─────────────────────────────────────────────────────────────── */

export interface GlancePetSlice {
  updatedAt: number
  enabled: boolean
  mood: "content" | "happy" | "tired" | "lonely" | "grumpy" | null
  condition: "well" | "unwell" | null
  energy: number
  moodLevel: number
  bond: number
}

/* ── Whole snapshot ──────────────────────────────────────────────────── */

export interface GlanceSnapshotV1 {
  version: typeof GLANCE_SNAPSHOT_VERSION
  /** Identifies one main-window session; see `IslandState.epoch` for why. */
  epoch: number
  /** Monotonic within an epoch. A consumer drops anything older. */
  revision: number
  generatedAt: number
  /** The persisted layout and options, normalized. */
  config: GlancePanelSettings
  /** The active workspace, for the header's scope switch. */
  workspace: { id: string; name: string } | null
  /** App state the quick actions' `when` expressions read. Usage is omitted. */
  when: TrayStateSnapshot
  /**
   * Slices for the VISIBLE modules only. A hidden module's slice is null, and
   * the publisher does not compute it.
   */
  fleet: GlanceFleetSlice | null
  usage: GlanceUsageSlice | null
  quota: GlanceQuotaSlice | null
  agenda: GlanceAgendaSlice | null
  activity: GlanceActivitySlice | null
  recents: GlanceRecentsSlice | null
  pet: GlancePetSlice | null
}

/** True when `next` should replace `current` (newer epoch, or same epoch and higher revision). */
export function isNewerSnapshot(
  current: Pick<GlanceSnapshotV1, "epoch" | "revision"> | null,
  next: Pick<GlanceSnapshotV1, "epoch" | "revision">
): boolean {
  if (!current) return true
  if (next.epoch !== current.epoch) return true
  return next.revision > current.revision
}

/** Structural check for a payload that arrived over IPC. */
export function isGlanceSnapshot(value: unknown): value is GlanceSnapshotV1 {
  if (typeof value !== "object" || value === null) return false
  const v = value as Partial<GlanceSnapshotV1>
  return (
    v.version === GLANCE_SNAPSHOT_VERSION &&
    typeof v.epoch === "number" &&
    typeof v.revision === "number" &&
    typeof v.generatedAt === "number" &&
    typeof v.config === "object" &&
    v.config !== null &&
    typeof v.when === "object" &&
    v.when !== null
  )
}
