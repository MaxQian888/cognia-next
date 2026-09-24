// Unified Notification Center — canonical types (ADR-0042).
//
// One `notify()` pipe writes a durable `NotificationRecord` to Dexie (the
// "center" channel) and fans out to toast / OS / push under user preferences.
// All notification subsystems (scheduler, agent-team, plugin, connector,
// session, push) funnel through this single contract.
//
// See `docs/superpowers/specs/2026-06-02-unified-notification-center-design.md`
// and `docs/content/docs/{en,zh}/adr/0042-unified-notification-center.md`.

/** Which subsystem emitted the notification. Extensible union. */
export type NotificationSource =
  | "scheduler"
  | "agent-team"
  | "plugin"
  | "connector"
  | "session"
  | "workflow"
  | "system"
  /** Issue tracker lifecycle (ADR-0132): assignments, run outcomes, review-ready, comments. */
  | "issue"
  /**
   * Cognia Sites publish lifecycle (ADR-0084): deploy outcomes, build and
   * upload failures, operations waiting on reconciliation. A build takes
   * minutes; without these, finishing one while the user is on another route
   * produced nothing at all.
   */
  | "site"

/** Severity / obtrusiveness tier. `critical` bypasses DND + per-source mute. */
export type NotificationLevel = "info" | "success" | "warning" | "error" | "critical"

/**
 * Delivery target. `center` is always implied (the durable Dexie record);
 * `toast`/`os`/`push` are ephemeral/external fan-out channels. `im` is the
 * control-plane proactive-push channel: it routes an agent event back to a
 * bound IM conversation (opt-in + PII-gated; see `lib/notifications/im-deliver`).
 */
export type NotificationChannel = "center" | "toast" | "os" | "push" | "im"

/**
 * Monotonic read lifecycle (GitHub Inbox / Novu MessageEntity model):
 *   unseen → seen → read → done(archived)
 * Cascade is enforced by the store: read ⇒ seen; done ⇒ seen + read.
 */
export type NotificationReadState = "unseen" | "seen" | "read" | "done"

export const NOTIFICATION_SOURCES: readonly NotificationSource[] = [
  "scheduler",
  "agent-team",
  "plugin",
  "connector",
  "session",
  "workflow",
  "system",
  "issue",
  "site",
] as const

export const NOTIFICATION_LEVELS: readonly NotificationLevel[] = [
  "info",
  "success",
  "warning",
  "error",
  "critical",
] as const

/** Ascending obtrusiveness rank — used for `minOsLevel` / `minPushLevel` gates. */
export const NOTIFICATION_LEVEL_RANK: Record<NotificationLevel, number> = {
  info: 0,
  success: 1,
  warning: 2,
  error: 3,
  critical: 4,
}

/**
 * A serializable call-to-action. NO closures — actions persist to Dexie, so
 * the handler is referenced by a registered `command` key (resolved through
 * `lib/notifications/action-registry`). Mirrors the existing plugin
 * `onAction(id, action: string)` string-command convention.
 */
export interface NotificationAction {
  id: string
  /** Display label (literal or i18n key, resolved by the renderer). */
  label: string
  /** Registered command key dispatched on click. */
  command: string
  args?: Record<string, unknown>
  variant?: "primary" | "secondary"
}

/** Reference back to the originating domain entity (for navigation / dedup). */
export interface NotificationSourceRef {
  kind: string
  id: string
}

/** What callers hand to `notify()`. */
export interface NotificationInput {
  source: NotificationSource
  level: NotificationLevel
  title: string
  body?: string
  /** Optional channel override; intersected with the resolved preferences. */
  channels?: NotificationChannel[]
  /** Coalesce within a window — same key bumps the existing record's `count`. */
  dedupeKey?: string
  /** UI grouping key (e.g. conversationKey, runId). */
  groupKey?: string
  /** Whole-item navigation target. */
  href?: string
  /** 1–3 inline actions, persisted on the center row. */
  actions?: NotificationAction[]
  sourceRef?: NotificationSourceRef
  pluginId?: string
  /**
   * The workspace this notification came FROM.
   *
   * Labels the source; it deliberately does not filter the feed. A cross-
   * workspace reminder is the feedback loop that makes concurrent work
   * possible — folding the notification centre down to the active workspace
   * would throw away half of what it is for. What was missing is the other
   * half: "needs approval" could not say which workspace or which conversation
   * it came from, so the user clicked through and only then discovered the
   * workbench had switched underneath them.
   *
   * Resolved from the session when the caller does not name one. Absent for
   * genuinely machine-wide events (an update, a licence, a device pairing).
   */
  projectId?: string
  /** Lucide icon name (renderer maps to a component). */
  icon?: string
  /**
   * True ⇒ "directed at you / needs action" (mention, DM, approval) → counts
   * toward the red numeric badge. False ⇒ ambient activity → dot only.
   */
  directed?: boolean
  /** Optional auto-expire (ms from creation). */
  ttlMs?: number
  /** Opt into BACKOFF coalescing (window extends on each new event). */
  coalesceBackoff?: boolean
  /**
   * Coalescing window override (ms) for `dedupeKey`; default 45 s. Recurring
   * producers (a scheduled task's outcome, a due reminder) pass
   * `COALESCE_UNTIL_ARCHIVED` (`lib/notifications/dedup`) so every repeat
   * updates ONE row — bumping `count` and re-surfacing it as unseen — until
   * the user archives it, instead of adding a row per occurrence.
   */
  coalesceWindowMs?: number
  meta?: Record<string, unknown>
  // ── V2 (opt-in; absent = legacy behavior) ────────────────────────────────
  /**
   * The fact's stable identity — `{kind}:{id}` namespaced by the producer
   * (e.g. `run:01J…`, `task:xyz:complete:exec-42`). Distinct from `dedupeKey`:
   * dedupe coalesces a WINDOW, logicalKey names the FACT. When set, it
   * participates in the publication/delivery-slot identity and survives
   * coalescing intact.
   */
  logicalKey?: string
  /**
   * The fact's category — subscriptions match on it. When absent the planner
   * derives one from `source`; producers that know better (run progress,
   * approval request) set it explicitly.
   */
  category?: import("./decision").NotificationCategory
  /**
   * Render hint for the center + external surfaces. `full` = normal card;
   * `badge` = count-only (a "+3" rollup); `silent` = durable record, no
   * obtrusive chrome anywhere (still queryable). Independent of `level` —
   * a `critical` fact may still render `silent` when a subscription says so.
   */
  presentation?: "full" | "badge" | "silent"
  /**
   * Optional explicit scope hint — the planner resolves the full
   * `NotificationScope` from it. Producers that already know their
   * authorization domain (a bound IM session's account, a scheduler's
   * workspace) pass it; the center derives the rest.
   */
  scopeHint?: {
    accountId?: string
    workspaceId?: string
    businessProjectId?: string
    runtimeId?: string
    executionHostId?: string
  }
  /**
   * Idempotency key for the WHOLE notify() call — retries of the same
   * operation key collapse to one durable record + one fan-out plan.
   * Distinct from `logicalKey` (the fact) and `dedupeKey` (the window).
   */
  operationKey?: string
  /** Absolute validity deadline — an expired fact never delivers. */
  validUntil?: number
}

/** Durable stored record (Dexie `notifications` table). */
export interface NotificationRecord {
  id: string
  source: NotificationSource
  level: NotificationLevel
  title: string
  body?: string
  createdAt: number
  updatedAt: number
  readState: NotificationReadState
  firstSeenAt?: number
  lastSeenAt?: number
  lastReadAt?: number
  doneAt?: number
  /** When set and `> now`, the record is hidden from the active feed. */
  snoozedUntil?: number
  /** INDEXED — coalescing key. */
  dedupeKey?: string
  /** INDEXED — display grouping key. */
  groupKey?: string
  /** Coalesced occurrence count (≥ 1). */
  count: number
  href?: string
  actions?: NotificationAction[]
  sourceRef?: NotificationSourceRef
  pluginId?: string
  /**
   * The workspace this notification came FROM.
   *
   * Labels the source; it deliberately does not filter the feed. A cross-
   * workspace reminder is the feedback loop that makes concurrent work
   * possible — folding the notification centre down to the active workspace
   * would throw away half of what it is for. What was missing is the other
   * half: "needs approval" could not say which workspace or which conversation
   * it came from, so the user clicked through and only then discovered the
   * workbench had switched underneath them.
   *
   * Resolved from the session when the caller does not name one. Absent for
   * genuinely machine-wide events (an update, a licence, a device pairing).
   */
  projectId?: string
  icon?: string
  directed: boolean
  /** Diagnostic: which fan-out channels actually fired. */
  deliveredVia: NotificationChannel[]
  /** When set, the record auto-expires at this epoch-ms (from `ttlMs`). */
  expiresAt?: number
  meta?: Record<string, unknown>
  // ── V2 (optional; absent on legacy rows) ─────────────────────────────────
  /** The fact's stable identity — survives coalescing, joins publications. */
  logicalKey?: string
  /** The fact's category — subscriptions match on it. */
  category?: import("./decision").NotificationCategory
  /** Render hint — `full` | `badge` | `silent`. */
  presentation?: "full" | "badge" | "silent"
  /** Canonical encoding of the fact's stable scope — `notificationScopeKey`. */
  scopeKey?: string
  /**
   * Monotonic per-fact revision — bumps on each commit-first write that
   * materially changes the fact (coalesce count, presentation flip). Delivery
   * intents CAS on it so a stale plan can't overwrite a newer fact.
   */
  notificationRevision?: number
  /** Correlation id tying a fact to its producer operation (trace/debug). */
  correlationId?: string
  /** The policy-state row id holding this fact's latest committed decision. */
  policyStateId?: string
}

/** Per-source override — an exception to the global default. */
export interface NotificationSourcePref {
  /** False ⇒ strip toast/os/push (still records to center; critical bypasses). */
  enabled: boolean
  /** Override the allowed channels for this source. */
  channels?: NotificationChannel[]
  /** Gate OS for this source to ≥ this level. */
  minOsLevel?: NotificationLevel
}

export interface NotificationQuietHours {
  enabled: boolean
  /** "HH:mm" in the user's local timezone. */
  start: string
  /** "HH:mm"; may wrap past midnight (start > end). */
  end: string
}

export interface NotificationPreferences {
  /** Default channels applied when no per-source override exists. */
  globalDefaultChannels: NotificationChannel[]
  /** Global OS gate — only levels ≥ this fire an OS notification. */
  minOsLevel: NotificationLevel
  /** Global push gate. */
  minPushLevel: NotificationLevel
  perSource: Partial<Record<NotificationSource, NotificationSourcePref>>
  quietHours: NotificationQuietHours
  sound: boolean
  badge: boolean
  /** Retention: prune records older than this (ms). */
  retentionMaxAgeMs: number
  /** Retention: keep at most this many records. */
  retentionMaxItems: number
  /** Connector inbound: suppress OS while the relevant conversation is viewed. */
  connectorFocusAware: boolean
  /** Snooze re-surfaces on new activity in the same `groupKey`. */
  snoozeAutoWakeOnActivity: boolean
}

const DAY_MS = 24 * 60 * 60 * 1000

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  globalDefaultChannels: ["center", "toast"],
  minOsLevel: "warning",
  minPushLevel: "warning",
  perSource: {},
  quietHours: { enabled: false, start: "22:00", end: "08:00" },
  sound: true,
  badge: true,
  retentionMaxAgeMs: 30 * DAY_MS,
  retentionMaxItems: 500,
  connectorFocusAware: true,
  snoozeAutoWakeOnActivity: true,
}

// ── V2 re-exports ──────────────────────────────────────────────────────────
// Consumers can keep importing from `@/types/notifications` and pick up the
// V2 contracts alongside the V1 record/preferences. The modules are split so
// each carries one cohesive contract (scope, target, subscription, decision,
// delivery rows, result summaries).
export * from "./scope"
export * from "./target"
export * from "./subscription"
export * from "./decision"
export * from "./delivery"
export * from "./result"
