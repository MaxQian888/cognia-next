"use client"

/**
 * useFleetHistorySink — persists live fleet sessions into the `fleetSessions`
 * Dexie table so history survives the island closing / the app restarting
 * (the Rust registry is in-memory only). Mount once in the main window; it
 * subscribes to the same `fleet://update` stream the island uses and upserts a
 * summary row per session.
 *
 * Kept separate from `useFleetStream` (island rendering) so the history write
 * runs in the main window even when the island overlay is closed.
 */

import { useEffect } from "react"
import { useFleetStream } from "./use-fleet-stream"
import { recordFleetHistory, type FleetSessionHistoryRow } from "@/lib/db/fleet-sessions"
import type { FleetSession } from "@/lib/fleet/types"
import { fleetHistoryId } from "@/lib/db/fleet-sessions"

/** Project one live session into a persistable history row. Pure. */
export function toHistoryRow(session: FleetSession, updatedAt: number): FleetSessionHistoryRow {
  const ended = session.status === "ended"
  return {
    id: fleetHistoryId(session.agent, session.sessionId),
    agent: session.agent,
    sessionId: session.sessionId,
    cwd: session.cwd,
    projectName: session.projectName,
    firstPrompt: session.lastPrompt,
    terminalLabel: session.terminal?.label ?? null,
    transcriptPath: session.transcriptPath,
    startedAt: session.startedAt,
    updatedAt,
    endedAt: ended ? (session.endedAt ?? updatedAt) : null,
    outcome: ended ? "ended" : "active",
  }
}

export function useFleetHistorySink(): void {
  const { snapshot, available } = useFleetStream()

  useEffect(() => {
    if (!available || snapshot.sessions.length === 0) return
    const updatedAt = snapshot.generatedAt || Date.now()
    for (const session of snapshot.sessions) {
      void recordFleetHistory(toHistoryRow(session, updatedAt))
    }
  }, [available, snapshot])
}
