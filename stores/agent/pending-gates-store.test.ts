/** @jest-environment jsdom */
import { usePendingGatesStore, gateTypeFromScope } from "./pending-gates-store"

beforeEach(() => {
  window.localStorage.clear()
  usePendingGatesStore.setState({ gates: [] })
})

const budgetGate = (overrides: Record<string, unknown> = {}) => ({
  key: { scope: "agent-team-budget", id: "run-1" },
  gateType: "budget" as const,
  title: "Budget",
  runId: "run-1",
  teamId: "team-1",
  ...overrides,
})

describe("PendingGatesStore", () => {
  it("open adds a live gate", () => {
    usePendingGatesStore.getState().open(budgetGate())
    const gates = usePendingGatesStore.getState().gates
    expect(gates).toHaveLength(1)
    expect(gates[0]?.status).toBe("open")
  })

  it("open deduplicates by scope+id while the existing gate is live", () => {
    const g = usePendingGatesStore.getState()
    g.open(budgetGate({ title: "Budget 1" }))
    g.open(budgetGate({ title: "Budget 2" }))
    expect(usePendingGatesStore.getState().gates).toHaveLength(1)
    expect(usePendingGatesStore.getState().gates[0]?.title).toBe("Budget 1")
  })

  it("open replaces an interrupted duplicate with the fresh live gate", () => {
    usePendingGatesStore.getState().open(budgetGate({ title: "stale" }))
    usePendingGatesStore.setState((s) => ({
      gates: s.gates.map((gate) => ({ ...gate, status: "interrupted" as const })),
    }))
    usePendingGatesStore.getState().open(budgetGate({ title: "fresh" }))
    const gates = usePendingGatesStore.getState().gates
    expect(gates).toHaveLength(1)
    expect(gates[0]?.title).toBe("fresh")
    expect(gates[0]?.status).toBe("open")
  })

  it("close removes the matching gate regardless of status", () => {
    const g = usePendingGatesStore.getState()
    g.open(budgetGate())
    usePendingGatesStore.setState((s) => ({
      gates: s.gates.map((gate) => ({ ...gate, status: "interrupted" as const })),
    }))
    g.close({ scope: "agent-team-budget", id: "run-1" })
    expect(usePendingGatesStore.getState().gates).toHaveLength(0)
  })

  it("clearForRun drops all gates for a runId (both statuses)", () => {
    const g = usePendingGatesStore.getState()
    g.open(budgetGate({ title: "B1" }))
    g.open({
      key: { scope: "agent-team-deadlock", id: "run-1" },
      gateType: "deadlock",
      title: "D1",
      runId: "run-1",
      teamId: "team-1",
    })
    g.open(
      budgetGate({ key: { scope: "agent-team-budget", id: "run-2" }, title: "B2", runId: "run-2" })
    )
    usePendingGatesStore.setState((s) => ({
      gates: s.gates.map((gate) =>
        gate.runId === "run-1" ? { ...gate, status: "interrupted" as const } : gate
      ),
    }))
    g.clearForRun("run-1")
    expect(usePendingGatesStore.getState().gates).toHaveLength(1)
    expect(usePendingGatesStore.getState().gates[0]?.runId).toBe("run-2")
  })

  it("persists gates to localStorage under cognia-pending-gates", () => {
    usePendingGatesStore.getState().open(budgetGate())
    const raw = window.localStorage.getItem("cognia-pending-gates")
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw as string)
    expect(parsed.state.gates).toHaveLength(1)
  })

  it("rehydration marks every restored gate interrupted (waiter died with the page)", async () => {
    usePendingGatesStore.getState().open(budgetGate())
    expect(usePendingGatesStore.getState().gates[0]?.status).toBe("open")
    // Simulate the next page load: rehydrate from the persisted snapshot.
    await usePendingGatesStore.persist.rehydrate()
    const gates = usePendingGatesStore.getState().gates
    expect(gates).toHaveLength(1)
    expect(gates[0]?.status).toBe("interrupted")
  })

  it("migrates legacy persisted rows (no status field) to interrupted", async () => {
    window.localStorage.setItem(
      "cognia-pending-gates",
      JSON.stringify({
        state: { gates: [{ ...budgetGate(), openedAt: 1 }] },
        version: 0,
      })
    )
    await usePendingGatesStore.persist.rehydrate()
    expect(usePendingGatesStore.getState().gates[0]?.status).toBe("interrupted")
  })

  it("gateTypeFromScope maps known scopes", () => {
    expect(gateTypeFromScope("agent-team-budget")).toBe("budget")
    expect(gateTypeFromScope("agent-team-deadlock")).toBe("deadlock")
    expect(gateTypeFromScope("agent-team-teammate-fix")).toBe("teammate_fix")
    expect(gateTypeFromScope("agent-team-replan")).toBe("replan")
    expect(gateTypeFromScope("agent-team-capability-audit")).toBe("capability_audit")
    expect(gateTypeFromScope("agent-team")).toBe("plan")
    expect(gateTypeFromScope("unknown")).toBe("plan")
  })

  // ADR-0045: a plan `approval_gate` step must not fall through to the team
  // "plan" variant — the two ask different questions and read different keys.
  it("gateTypeFromScope maps the plan-step scope", () => {
    expect(gateTypeFromScope("agent-plan")).toBe("plan_step")
  })

  it("clearForPlan drops only that plan's gates", () => {
    const store = usePendingGatesStore.getState()
    store.open({
      key: { scope: "agent-plan", id: "p1:s1" },
      gateType: "plan_step",
      title: "Step one",
      planId: "p1",
      sessionId: "ses",
    })
    store.open({
      key: { scope: "agent-plan", id: "p2:s1" },
      gateType: "plan_step",
      title: "Other plan",
      planId: "p2",
      sessionId: "ses",
    })
    usePendingGatesStore.getState().clearForPlan("p1")
    const left = usePendingGatesStore.getState().gates
    expect(left).toHaveLength(1)
    expect(left[0].planId).toBe("p2")
  })

  it("keeps team gates when a plan is cleared", () => {
    const store = usePendingGatesStore.getState()
    store.open(budgetGate())
    usePendingGatesStore.getState().clearForPlan("p1")
    expect(usePendingGatesStore.getState().gates).toHaveLength(1)
  })
})
