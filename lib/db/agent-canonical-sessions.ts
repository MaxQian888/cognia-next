// Canonical-session header projection accessors (ADR-0090 Phase 8, Dexie
// v124).
//
// The AUTHORITY for canonical content is the envelope stream on the workflow
// event-log plus the codec conversions; this table only indexes session
// HEADERS for listing/lookup and is rebuildable from those sources at any
// time. Rows carry no turn content and no secrets.

import type {
  CanonicalSession,
  SessionFidelity,
  SessionLossReport,
} from "@cognia/agent-config-types/canonical-session"

import { getDb } from "./schema"

export interface AgentCanonicalSessionRow {
  canonicalSessionId: string
  sourceRuntime: string
  /** Native runtime handle when one exists ("" when absent — indexable). */
  nativeSessionId: string
  title?: string
  turnCount: number
  importFidelity: SessionFidelity
  sequenceDigest: string
  /** Loss summary of the LAST conversion that produced this header. */
  lossCount: number
  rebuilt: boolean
  createdAt: number
  updatedAt: number
}

export function headerRowFromCanonical(
  session: CanonicalSession,
  loss: SessionLossReport
): AgentCanonicalSessionRow {
  const header = session.header
  return {
    canonicalSessionId: header.canonicalSessionId,
    sourceRuntime: header.sourceRuntime,
    nativeSessionId: header.runtimeBinding?.nativeSessionId ?? "",
    ...(header.title ? { title: header.title } : {}),
    turnCount: header.turnCount,
    importFidelity: header.importFidelity,
    sequenceDigest: header.sequenceDigest,
    lossCount: loss.losses.length,
    rebuilt: loss.rebuilt === true,
    createdAt: Date.parse(header.createdAt) || Date.now(),
    updatedAt: Date.parse(header.updatedAt) || Date.now(),
  }
}

/** Upsert one header projection row. */
export async function putCanonicalSessionHeader(row: AgentCanonicalSessionRow): Promise<void> {
  await getDb().agentCanonicalSessions.put(row)
}

export async function getCanonicalSessionHeader(
  canonicalSessionId: string
): Promise<AgentCanonicalSessionRow | undefined> {
  return getDb().agentCanonicalSessions.get(canonicalSessionId)
}

export async function listCanonicalSessionHeaders(options?: {
  sourceRuntime?: string
}): Promise<AgentCanonicalSessionRow[]> {
  const table = getDb().agentCanonicalSessions
  const rows = options?.sourceRuntime
    ? await table.where("sourceRuntime").equals(options.sourceRuntime).toArray()
    : await table.toArray()
  return rows.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Find the header bound to a native runtime session id (recovery lookup). */
export async function findByNativeSessionId(
  nativeSessionId: string
): Promise<AgentCanonicalSessionRow | undefined> {
  if (!nativeSessionId) return undefined
  return getDb().agentCanonicalSessions.where("nativeSessionId").equals(nativeSessionId).first()
}

export async function deleteCanonicalSessionHeader(canonicalSessionId: string): Promise<void> {
  await getDb().agentCanonicalSessions.delete(canonicalSessionId)
}
