/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { renderHook, waitFor } from "@testing-library/react"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { createPlan } from "@/lib/db/plans"
import { DEFAULT_PLAN_CONFIG, type AgentPlan } from "@/types/agent/plan"
import { usePlanById, useSessionPlan } from "./use-session-plan"

function buildPlan(over: Partial<AgentPlan>): Parameters<typeof createPlan>[0] {
  return {
    id: over.id ?? "p1",
    sessionId: over.sessionId ?? "ses",
    title: "Plan",
    source: "manual",
    executionMode: "auto",
    steps: [],
    status: over.status ?? "approved",
    totalSteps: 0,
    completedSteps: 0,
    config: DEFAULT_PLAN_CONFIG,
    refinementCount: 0,
    generationId: "g",
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("useSessionPlan", () => {
  it("returns the open plan for a session", async () => {
    await createPlan(buildPlan({ id: "p1", sessionId: "ses", status: "approved" }))
    const { result } = renderHook(() => useSessionPlan("ses"))
    await waitFor(() => expect(result.current?.id).toBe("p1"))
  })

  it("returns undefined when no session id is given", () => {
    const { result } = renderHook(() => useSessionPlan(undefined))
    expect(result.current).toBeUndefined()
  })

  it("ignores terminal plans (no open plan)", async () => {
    await createPlan(buildPlan({ id: "p_done", sessionId: "ses2", status: "completed" }))
    const { result } = renderHook(() => useSessionPlan("ses2"))
    // Give the live query a tick to resolve to undefined.
    await waitFor(() => expect(result.current).toBeUndefined())
  })
})

describe("usePlanById", () => {
  it("returns the plan by id", async () => {
    await createPlan(buildPlan({ id: "pX", sessionId: "s" }))
    const { result } = renderHook(() => usePlanById("pX"))
    await waitFor(() => expect(result.current?.id).toBe("pX"))
  })

  it("returns undefined for no id", () => {
    const { result } = renderHook(() => usePlanById(undefined))
    expect(result.current).toBeUndefined()
  })
})
