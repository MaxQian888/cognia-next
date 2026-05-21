/**
 * Per-session in-memory ring buffer of trigger fan-outs.
 *
 * Populated whenever `lib/db/messages.ts:dispatchChatMessageTriggers`
 * (or any future trigger source we add the hook to) fires a workflow
 * for a freshly-arrived message. The chat surface reads from the same
 * ring to render the `<TriggerBadge>` next to each message; the
 * plugin devtools Triggers tab reads it to show a cross-plugin log.
 *
 * Bounded to 200 entries per session — older rows fall off the front.
 * Cleared automatically when the session is unmounted or by tests.
 */

export type TriggerAuditStatus = "dispatched" | "rejected" | "error"

export interface TriggerAuditEntry {
  /** Stable id so the UI can key React lists / dedupe. */
  id: string
  sessionId: string
  /** Message that triggered the fan-out. Null for non-message triggers. */
  messageId: string | null
  /** Plugin-prefixed kind (`trigger.foo.bar`, `trigger.chat.message`, …). */
  kind: string
  /** Owning plugin id, or `null` for built-in triggers. */
  pluginId: string | null
  /** Workflow that was invoked. */
  workflowId: string
  /** Optional human label (workflow name) used by the badge popover. */
  workflowLabel?: string
  status: TriggerAuditStatus
  timestamp: number
  /** Free-form error string when `status === "error"`. */
  errorMessage?: string
}

interface RingState {
  entries: TriggerAuditEntry[]
}

const PER_SESSION_LIMIT = 200
const sessions = new Map<string, RingState>()
const listeners = new Set<() => void>()
let revision = 0

function notify(): void {
  revision += 1
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // listeners must never break the dispatcher
    }
  }
}

function ringFor(sessionId: string): RingState {
  let row = sessions.get(sessionId)
  if (!row) {
    row = { entries: [] }
    sessions.set(sessionId, row)
  }
  return row
}

let counter = 0
function nextId(): string {
  counter += 1
  return `tau-${Date.now().toString(36)}-${counter.toString(36)}`
}

export function recordTriggerAuditEntry(
  entry: Omit<TriggerAuditEntry, "id" | "timestamp"> & {
    id?: string
    timestamp?: number
  }
): TriggerAuditEntry {
  const row = ringFor(entry.sessionId)
  const finalEntry: TriggerAuditEntry = {
    id: entry.id ?? nextId(),
    sessionId: entry.sessionId,
    messageId: entry.messageId,
    kind: entry.kind,
    pluginId: entry.pluginId,
    workflowId: entry.workflowId,
    workflowLabel: entry.workflowLabel,
    status: entry.status,
    timestamp: entry.timestamp ?? Date.now(),
    errorMessage: entry.errorMessage,
  }
  row.entries.push(finalEntry)
  if (row.entries.length > PER_SESSION_LIMIT) {
    row.entries = row.entries.slice(-PER_SESSION_LIMIT)
  }
  notify()
  return finalEntry
}

export function listTriggerAuditEntries(filter: {
  sessionId: string
  messageId?: string | null
  pluginId?: string | null
  kind?: string
  limit?: number
}): TriggerAuditEntry[] {
  const row = sessions.get(filter.sessionId)
  if (!row) return []
  let entries = row.entries
  if (filter.messageId !== undefined) {
    entries = entries.filter((e) => e.messageId === filter.messageId)
  }
  if (filter.pluginId !== undefined) {
    entries = entries.filter((e) => e.pluginId === filter.pluginId)
  }
  if (filter.kind) {
    entries = entries.filter((e) => e.kind === filter.kind)
  }
  if (typeof filter.limit === "number") {
    entries = entries.slice(-filter.limit)
  }
  return entries.map((e) => ({ ...e }))
}

/**
 * Cross-session reader for the devtools Triggers tab. Returns the most
 * recent N entries across all sessions, newest last.
 */
export function listAllTriggerAuditEntries(limit = 200): TriggerAuditEntry[] {
  const all: TriggerAuditEntry[] = []
  for (const row of sessions.values()) {
    all.push(...row.entries)
  }
  all.sort((a, b) => a.timestamp - b.timestamp)
  return all.slice(-limit)
}

export function countTriggerAuditForMessage(sessionId: string, messageId: string): number {
  return listTriggerAuditEntries({ sessionId, messageId }).length
}

export function clearTriggerAuditForSession(sessionId: string): void {
  if (sessions.delete(sessionId)) notify()
}

export function clearAllTriggerAudit(): void {
  if (sessions.size === 0) return
  sessions.clear()
  notify()
}

export function subscribeTriggerAuditChanges(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getTriggerAuditRevision(): number {
  return revision
}
