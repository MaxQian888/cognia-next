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

import { useEffect, useRef } from "react"
import { useFleetStream } from "./use-fleet-stream"
import { reconcileFleetHistory, type FleetSessionHistoryRow } from "@/lib/db/fleet-sessions"
import type { FleetSession } from "@/lib/fleet/types"
import { fleetHistoryId } from "@/lib/db/fleet-sessions"
import { fleetCanonicalRunId, projectFleetSessionEnvelopes } from "@/lib/fleet/canonical-projection"
import { appendCanonicalEnvelopes } from "@/lib/ai/agent/recovery/canonical-log"
import { redactText } from "@cognia/redact"

/** Project one live session into a persistable history row. Pure. */
export function toHistoryRow(session: FleetSession, updatedAt: number): FleetSessionHistoryRow {
  const ended = session.status === "ended"
  return {
    id: fleetHistoryId(session.agent, session.sessionId),
    agent: session.agent,
    sessionId: session.sessionId,
    cwd: session.cwd,
    projectName: session.projectName,
    firstPrompt: session.lastPrompt ? redactText(session.lastPrompt).redacted : null,
    terminalLabel: session.terminal?.label ?? null,
    transcriptPath: session.transcriptPath,
    startedAt: session.startedAt,
    updatedAt,
    endedAt: ended ? (session.endedAt ?? updatedAt) : null,
    outcome: ended ? "ended" : "active",
    canonicalRunId: fleetCanonicalRunId(session),
    toolUseCount: session.toolUseCount,
    turnCount: session.turnCount,
    lastErrorKind: session.lastError?.kind ?? null,
    lastErrorDetail: session.lastError?.detail
      ? redactText(session.lastError.detail).redacted
      : null,
  }
}

export function useFleetHistorySink(): void {
  const { snapshot, available } = useFleetStream()
  const previousBySession = useRef(new Map<string, FleetSession>())

  useEffect(() => {
    if (!available) return
    const updatedAt = snapshot.generatedAt || Date.now()
    void reconcileFleetHistory(
      snapshot.sessions.map((session) => toHistoryRow(session, updatedAt)),
      updatedAt
    )
    for (const session of snapshot.sessions) {
      const identity = fleetHistoryId(session.agent, session.sessionId)
      const previous = previousBySession.current.get(identity)
      const envelopes = projectFleetSessionEnvelopes(previous, session)
      previousBySession.current.set(identity, session)
      if (envelopes.length > 0) {
        void appendCanonicalEnvelopes(fleetCanonicalRunId(session), envelopes).catch((error) => {
          console.warn("Fleet canonical journal append failed", error)
        })
      }
    }
  }, [available, snapshot])
}
