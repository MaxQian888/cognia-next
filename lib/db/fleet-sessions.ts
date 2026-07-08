/**
 * CRUD layer for the `fleetSessions` Dexie table (v105) — history of
 * externally-launched coding-agent sessions the fleet monitor observed.
 *
 * Written by `hooks/fleet/use-fleet-history-sink.ts` from the live
 * `fleet://update` stream (the Rust registry is in-memory and clears on app
 * restart, so persistence is the frontend's job). Read by the fleet settings
 * history list. Deep transcript view links out to the session-import
 * subsystem via `transcriptPath`.
 */

import type { FleetAgent } from "@/lib/fleet/types"
import { getDb } from "./schema"

/** Terminal outcome of a monitored session. */
export type FleetSessionOutcome = "active" | "ended"

export interface FleetSessionHistoryRow {
  /** Composite key `${agent}:${sessionId}` — stable across updates. */
  id: string
  agent: FleetAgent
  sessionId: string
  cwd: string | null
  projectName: string | null
  /** The first user prompt seen (kept even as the session progresses). */
  firstPrompt: string | null
  /** Runtime label of the dispatching terminal, when known. */
  terminalLabel: string | null
  transcriptPath: string | null
  startedAt: number
  /** Epoch ms of the most recent update. */
  updatedAt: number
  /** Epoch ms when the session ended, or null while still active. */
  endedAt: number | null
  outcome: FleetSessionOutcome
}

export function fleetHistoryId(agent: FleetAgent, sessionId: string): string {
  return `${agent}:${sessionId}`
}

/**
 * Upsert a history row, preserving fields that should only ever be set once
 * (`firstPrompt`, `startedAt`) and never regressing `endedAt`. Pure merge
 * exposed for unit testing; the DB write is in {@link recordFleetHistory}.
 */
export function mergeHistoryRow(
  existing: FleetSessionHistoryRow | undefined,
  incoming: FleetSessionHistoryRow
): FleetSessionHistoryRow {
  if (!existing) return incoming
  return {
    ...existing,
    ...incoming,
    // Sticky first-seen values.
    firstPrompt: existing.firstPrompt ?? incoming.firstPrompt,
    startedAt: existing.startedAt,
    // Never un-end a session; keep the earliest end.
    endedAt: existing.endedAt ?? incoming.endedAt,
    outcome: existing.endedAt !== null ? "ended" : incoming.outcome,
  }
}

export async function recordFleetHistory(incoming: FleetSessionHistoryRow): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.fleetSessions, async () => {
    const existing = await db.fleetSessions.get(incoming.id)
    await db.fleetSessions.put(mergeHistoryRow(existing, incoming))
  })
}

/** Most-recent sessions first (default 100). */
export async function listFleetHistory(limit = 100): Promise<FleetSessionHistoryRow[]> {
  return getDb().fleetSessions.orderBy("startedAt").reverse().limit(limit).toArray()
}

export async function getFleetHistory(
  agent: FleetAgent,
  sessionId: string
): Promise<FleetSessionHistoryRow | undefined> {
  return getDb().fleetSessions.get(fleetHistoryId(agent, sessionId))
}

export async function clearFleetHistory(): Promise<void> {
  await getDb().fleetSessions.clear()
}

/** Prune history older than `cutoff` (epoch ms). Returns rows removed. */
export async function pruneFleetHistory(cutoff: number): Promise<number> {
  return getDb().fleetSessions.where("startedAt").below(cutoff).delete()
}
