import {
  SESSION_WORKING_SET_CONTRACT_VERSION,
  type SessionWorkingSetV1,
  type WorkingSetEntry,
  type WorkingSetEntryKind,
  type WorkingSetEntryOrigin,
  type WorkingSetEntryStatus,
} from "@cognia/agent-config-types/working-set"
import type { ResourceRefV1 } from "@cognia/agent-config-types/governance"
import { hasNoLeakingPii, hasNoLeakingPiiDeep, redactText } from "@cognia/redact"

import { getDb, withDbReopenRetry } from "@/lib/db/schema"

export const WORKING_SET_MAX_ENTRIES = 32
export const WORKING_SET_MAX_SUMMARY_CHARS = 512
export const WORKING_SET_MAX_REFS = 4
export const WORKING_SET_MAX_BYTES = 8 * 1024

const ENTRY_KINDS = new Set<WorkingSetEntryKind>([
  "fact",
  "decision",
  "open-question",
  "resource",
  "subtask",
])
const ENTRY_ORIGINS = new Set<WorkingSetEntryOrigin>(["user", "agent"])
const ENTRY_STATUSES = new Set<WorkingSetEntryStatus>(["active", "resolved"])

export class WorkingSetConflictError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number
  ) {
    super(`Working set revision conflict: expected ${expectedRevision}, got ${actualRevision}`)
    this.name = "WorkingSetConflictError"
  }
}

export type WorkingSetMutation =
  | {
      sessionId: string
      expectedRevision: number
      action: "upsert"
      entry: {
        id?: string
        kind: WorkingSetEntryKind
        summary: string
        origin: WorkingSetEntryOrigin
        refs?: ResourceRefV1[]
        status?: WorkingSetEntryStatus
      }
      now?: number
    }
  | {
      sessionId: string
      expectedRevision: number
      action: "resolve" | "remove"
      entryId: string
      now?: number
    }

function emptyWorkingSet(): SessionWorkingSetV1 {
  return {
    contractVersion: SESSION_WORKING_SET_CONTRACT_VERSION,
    revision: 0,
    entries: [],
    updatedAt: 0,
  }
}

function validRef(ref: ResourceRefV1): boolean {
  return (
    Boolean(ref) &&
    typeof ref.namespace === "string" &&
    ref.namespace.trim().length > 0 &&
    typeof ref.type === "string" &&
    ref.type.trim().length > 0 &&
    typeof ref.id === "string" &&
    ref.id.trim().length > 0 &&
    !/^https?:\/\//i.test(ref.id)
  )
}

function validateEntryDraft(entry: Extract<WorkingSetMutation, { action: "upsert" }>["entry"]): {
  summary: string
  refs: ResourceRefV1[]
} {
  if (!ENTRY_KINDS.has(entry.kind)) throw new Error("Unknown working set entry kind")
  if (!ENTRY_ORIGINS.has(entry.origin)) throw new Error("Unknown working set entry origin")
  if (entry.status && !ENTRY_STATUSES.has(entry.status)) {
    throw new Error("Unknown working set entry status")
  }
  const rawSummary = entry.summary.trim()
  if (!rawSummary) throw new Error("Working set summary is required")
  if (rawSummary.length > WORKING_SET_MAX_SUMMARY_CHARS) {
    throw new Error(
      `Working set summary must be at most ${WORKING_SET_MAX_SUMMARY_CHARS} characters`
    )
  }
  const summary = redactText(rawSummary).redacted
  if (!hasNoLeakingPii(summary)) throw new Error("Working set summary rejected by the PII gate")
  const refs = entry.refs ?? []
  if (refs.length > WORKING_SET_MAX_REFS) {
    throw new Error(`Working set entry may contain at most ${WORKING_SET_MAX_REFS} refs`)
  }
  if (!refs.every(validRef)) throw new Error("Invalid working set resource reference")
  return { summary, refs }
}

function assertBounded(value: SessionWorkingSetV1): void {
  if (value.entries.length > WORKING_SET_MAX_ENTRIES) {
    throw new Error(`Working set may contain at most ${WORKING_SET_MAX_ENTRIES} entries`)
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > WORKING_SET_MAX_BYTES) {
    throw new Error(`Working set must be at most ${WORKING_SET_MAX_BYTES} bytes`)
  }
}

function assertSafeWorkingSet(value: SessionWorkingSetV1): void {
  if (!hasNoLeakingPiiDeep(value)) {
    throw new Error("Working set rejected by the PII gate")
  }
}

export async function readSessionWorkingSet(sessionId: string): Promise<SessionWorkingSetV1> {
  const session = await getDb().sessions.get(sessionId)
  if (!session) throw new Error(`Unknown chat session: ${sessionId}`)
  return session.workingSet ?? emptyWorkingSet()
}

/** Apply one user/model operation atomically without replacing concurrent state. */
export async function mutateSessionWorkingSet(
  mutation: WorkingSetMutation
): Promise<SessionWorkingSetV1> {
  return withDbReopenRetry(async () => {
    const db = getDb()
    return db.transaction("rw", db.sessions, async () => {
      const session = await db.sessions.get(mutation.sessionId)
      if (!session) throw new Error(`Unknown chat session: ${mutation.sessionId}`)
      const current = session.workingSet ?? emptyWorkingSet()
      if (current.revision !== mutation.expectedRevision) {
        throw new WorkingSetConflictError(mutation.expectedRevision, current.revision)
      }
      const now = mutation.now ?? Date.now()
      let entries: WorkingSetEntry[]

      if (mutation.action === "upsert") {
        const normalized = validateEntryDraft(mutation.entry)
        const entryId = mutation.entry.id?.trim() || crypto.randomUUID()
        const existing = current.entries.find((entry) => entry.id === entryId)
        const nextEntry: WorkingSetEntry = {
          id: entryId,
          kind: mutation.entry.kind,
          summary: normalized.summary,
          status: mutation.entry.status ?? existing?.status ?? "active",
          origin: mutation.entry.origin,
          refs: normalized.refs,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        }
        entries = existing
          ? current.entries.map((entry) => (entry.id === entryId ? nextEntry : entry))
          : [...current.entries, nextEntry]
      } else if (mutation.action === "resolve") {
        if (!current.entries.some((entry) => entry.id === mutation.entryId)) {
          throw new Error(`Unknown working set entry: ${mutation.entryId}`)
        }
        entries = current.entries.map((entry) =>
          entry.id === mutation.entryId
            ? { ...entry, status: "resolved" as const, updatedAt: now }
            : entry
        )
      } else {
        if (!current.entries.some((entry) => entry.id === mutation.entryId)) {
          throw new Error(`Unknown working set entry: ${mutation.entryId}`)
        }
        entries = current.entries.filter((entry) => entry.id !== mutation.entryId)
      }

      const next: SessionWorkingSetV1 = {
        contractVersion: SESSION_WORKING_SET_CONTRACT_VERSION,
        revision: current.revision + 1,
        entries,
        updatedAt: now,
      }
      assertBounded(next)
      assertSafeWorkingSet(next)
      await db.sessions.update(mutation.sessionId, { workingSet: next, updatedAt: now })
      return next
    })
  })
}

function fitUtf8(value: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(value)
  if (encoded.byteLength <= maxBytes) return value
  return new TextDecoder().decode(encoded.slice(0, maxBytes)).replace(/\uFFFD$/u, "")
}

/** Render the durable active subset for the existing one-shot recovery prompt. */
export function renderWorkingSetForCompaction(workingSet: SessionWorkingSetV1): string {
  assertSafeWorkingSet(workingSet)
  const active = workingSet.entries.filter((entry) => entry.status === "active")
  if (active.length === 0) return ""
  const lines = [
    "Active run working set (durable, user-visible):",
    ...active.map((entry) => {
      const refs = entry.refs.map((ref) => `${ref.namespace}:${ref.type}:${ref.id}`).join(", ")
      return `- [${entry.kind}] ${entry.summary}${refs ? ` (refs: ${refs})` : ""}`
    }),
  ]
  return fitUtf8(lines.join("\n"), WORKING_SET_MAX_BYTES)
}
