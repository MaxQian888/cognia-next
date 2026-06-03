"use client"

/**
 * Reactive read of the open `AgentPlan` for a chat session (ADR-0045 P5).
 *
 * Backed by `dexie-react-hooks:useLiveQuery`, so the approval card / tracker
 * panel re-render automatically as the plan runtime mutates the row
 * (created → approved → executing → step updates → terminal). Returns
 * `undefined` while loading or when the session has no open plan.
 */

import { useLiveQuery } from "dexie-react-hooks"
import { getOpenPlanForSession, getPlan } from "@/lib/db/plans"
import type { AgentPlan } from "@/types/agent/plan"

/** The session's current open plan (draft → paused), live. */
export function useSessionPlan(sessionId: string | undefined): AgentPlan | undefined {
  return useLiveQuery(
    () => (sessionId ? getOpenPlanForSession(sessionId) : Promise.resolve(undefined)),
    [sessionId]
  )
}

/** A specific plan by id, live. */
export function usePlanById(planId: string | undefined): AgentPlan | undefined {
  return useLiveQuery(() => (planId ? getPlan(planId) : Promise.resolve(undefined)), [planId])
}
