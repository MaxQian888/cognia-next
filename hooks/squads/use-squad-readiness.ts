"use client"

/**
 * Live readiness of one Squad, for the surfaces that show whether it can run
 * and what to fix if it cannot (ADR-0169).
 *
 * Wraps `evaluateSquadReadiness` in a live query keyed on the parts of the
 * definition it reads (the two bindings and the roster) and on the environment
 * tables, so binding an environment or adding a teammate clears the blocker
 * without a reload. `evaluateSquadReadiness` itself is pure over injected
 * readers and is what `startSquadRun` refuses with, so the card and the
 * refusal can never disagree.
 */

import { useMemo } from "react"

import { useClientLiveQuery } from "@/hooks/data"
import { evaluateSquadReadiness, type SquadReadiness } from "@/lib/agent-team/squad-readiness"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"

const PENDING: SquadReadiness = { ready: false, blockers: [], evaluatedAt: 0 }

export interface SquadReadinessState extends SquadReadiness {
  /** True until the first evaluation lands. Blockers are meaningless before. */
  loading: boolean
}

export function useSquadReadiness(squadId: string | undefined): SquadReadinessState {
  const team = useAgentTeamStore((s) => (squadId ? s.teams[squadId] : undefined))
  const teammates = useAgentTeamStore((s) => s.teammates)
  const roster = useMemo(
    () => (squadId ? Object.values(teammates).filter((m) => m.teamId === squadId) : []),
    [teammates, squadId]
  )
  const workerCount = roster.filter((m) => m.role === "teammate").length
  // The bindings are what readiness reads. Keying on their serialization,
  // rather than on the team object, keeps unrelated edits (a rename, a new
  // task) from re-running the environment lookup.
  const bindingKey = JSON.stringify([
    team?.config.repositories ?? null,
    team?.config.environmentRef ?? null,
  ])

  const readiness = useClientLiveQuery(
    async () => {
      if (!team) return PENDING
      try {
        return await evaluateSquadReadiness({ team, teammates: roster })
      } catch {
        return PENDING
      }
    },
    [squadId, bindingKey, workerCount],
    undefined
  )

  return useMemo(
    () =>
      readiness && readiness !== PENDING
        ? { ...readiness, loading: false }
        : { ...PENDING, loading: true },
    [readiness]
  )
}
