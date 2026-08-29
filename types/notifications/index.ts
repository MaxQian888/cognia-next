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
  meta?: Record<string, unknown>
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
