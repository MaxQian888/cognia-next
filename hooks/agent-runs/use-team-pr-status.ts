"use client"

/**
 * Live PR observation status for a team's workspace (ADR — team PR feedback).
 * Reads the durable `teamPrObservations` rows the PR feedback loop persists and
 * projects the newest observation per teammate, so the workspace can show each
 * teammate's PR status (ci_failed / changes_requested / mergeable / …) beside
 * their run status. Read-only liveQuery — never writes, so it can't trip the
 * cold-Dexie readwrite-in-liveQuery trap.
 */

import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import {
  listTeamPrObservationsByTeam,
  type TeamPrObservationRow,
} from "@/lib/db/team-pr-observations"

/** Live rows for a team, newest-first. */
export function useTeamPrObservations(teamId: string): TeamPrObservationRow[] {
  return useLiveQuery(() => listTeamPrObservationsByTeam(teamId), [teamId], [])
}

/**
 * Reduce observation rows to the newest one per teammate. Pure; exposed for unit
 * testing without React / Dexie. Rows may arrive in any order, so it compares
 * `updatedAt` rather than trusting position.
 */
export function pickNewestPerTeammate(
  rows: TeamPrObservationRow[]
): Map<string, TeamPrObservationRow> {
  const map = new Map<string, TeamPrObservationRow>()
  for (const r of rows) {
    const cur = map.get(r.teammateId)
    if (!cur || r.updatedAt > cur.updatedAt) map.set(r.teammateId, r)
  }
  return map
}

/** Newest PR observation per teammate for a team (live). */
export function useTeamPrStatusByTeammate(teamId: string): Map<string, TeamPrObservationRow> {
  const rows = useTeamPrObservations(teamId)
  return useMemo(() => pickNewestPerTeammate(rows), [rows])
}
