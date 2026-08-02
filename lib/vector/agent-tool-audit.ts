/**
 * Bounded in-memory audit ring for the host-routed vector agent tools.
 *
 * Mirrors `lib/files/audit.ts` (and `lib/chat/trigger-audit-ring.ts`): a
 * newest-first capped list with a subscribe hook, so a diagnostics surface can
 * render the recent vector-tool trail without a Dexie table.
 *
 * **Redaction is structural, not best-effort.** {@link recordVectorToolAudit}
 * accepts only the fields below — there is no free-form payload slot — so
 * document content, query text, metadata values and embeddings cannot reach
 * the ring even by accident. What is recorded is the project, the logical
 * collection, the operation, the result count and the document id.
 */

import { nanoid } from "nanoid"

/** Operations the vector agent tools can perform. */
export type VectorToolOperation = "search" | "add" | "delete"

/** Why a vector tool call did not run, when it did not run. */
export type VectorToolDenialReason =
  | "permission"
  | "unsupported-platform"
  | "pii"
  | "invalid-argument"
  | "cancelled"
  | "timeout"
  | "error"

export interface VectorToolAuditEntry {
  /** Stable id so UI lists can key/dedupe. */
  id: string
  /** Epoch ms the entry was recorded. */
  ts: number
  /** Project the call was scoped to. */
  projectId: string
  /** Logical (agent-facing) collection name — never the internal native name. */
  collection: string
  operation: VectorToolOperation
  /** Did the operation reach the store and succeed? */
  ok: boolean
  /**
   * Documents read (search) or written/removed (add/delete). Absent when the
   * call never reached the store.
   */
  count?: number
  /** Document id for single-document operations (add / delete). */
  documentId?: string
  /** Machine-readable reason when `ok === false`. */
  reason?: VectorToolDenialReason
}

/**
 * Everything the caller supplies. `id`/`ts` are generated here so stamping
 * stays in one place.
 */
export type VectorToolAuditDraft = Omit<VectorToolAuditEntry, "id" | "ts">

const MAX_AUDIT_ENTRIES = 200

let entries: VectorToolAuditEntry[] = []
const subscribers = new Set<() => void>()

function notifySubscribers(): void {
  for (const subscriber of subscribers) subscriber()
}

/**
 * Append one entry to the front of the ring and notify subscribers. Only the
 * whitelisted fields are copied — an over-supplied object is narrowed here, so
 * a future call site cannot smuggle content through structural typing.
 */
export function recordVectorToolAudit(draft: VectorToolAuditDraft): VectorToolAuditEntry {
  const entry: VectorToolAuditEntry = {
    id: `va-${nanoid()}`,
    ts: Date.now(),
    projectId: draft.projectId,
    collection: draft.collection,
    operation: draft.operation,
    ok: draft.ok,
    ...(draft.count !== undefined ? { count: draft.count } : {}),
    ...(draft.documentId !== undefined ? { documentId: draft.documentId } : {}),
    ...(draft.reason !== undefined ? { reason: draft.reason } : {}),
  }
  entries = [entry, ...entries].slice(0, MAX_AUDIT_ENTRIES)
  notifySubscribers()
  return entry
}

/** The most recent entries, newest first, capped at `limit`. */
export function getVectorToolAudit(limit = MAX_AUDIT_ENTRIES): VectorToolAuditEntry[] {
  return entries.slice(0, Math.max(0, limit))
}

/** Drop every recorded entry and notify. */
export function clearVectorToolAudit(): void {
  entries = []
  notifySubscribers()
}

/** Subscribe to ring changes. Returns the unsubscribe handle. */
export function subscribeVectorToolAudit(listener: () => void): () => void {
  subscribers.add(listener)
  return () => {
    subscribers.delete(listener)
  }
}

/** Ring capacity — exported so tests and UI paging agree on the bound. */
export const VECTOR_TOOL_AUDIT_CAP = MAX_AUDIT_ENTRIES
