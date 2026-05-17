import { usePendingGatesStore, gateTypeFromScope } from "./pending-gates-store"

beforeEach(() => {
  usePendingGatesStore.setState({ gates: [] })
})

describe("PendingGatesStore", () => {
  it("open adds a gate", () => {
    usePendingGatesStore.getState().open({
      key: { scope: "agent-team-budget", id: "run-1" },
      gateType: "budget",
      title: "Budget",
      runId: "run-1",
      teamId: "team-1",
    })
    expect(usePendingGatesStore.getState().gates).toHaveLength(1)
  })

  it("open deduplicates by scope+id", () => {
    const g = usePendingGatesStore.getState()
    g.open({
      key: { scope: "agent-team-budget", id: "run-1" },
      gateType: "budget",
      title: "Budget 1",
      runId: "run-1",
      teamId: "team-1",
    })
    g.open({
      key: { scope: "agent-team-budget", id: "run-1" },
      gateType: "budget",
      title: "Budget 2",
      runId: "run-1",
      teamId: "team-1",
    })
    expect(usePendingGatesStore.getState().gates).toHaveLength(1)
    expect(usePendingGatesStore.getState().gates[0]?.title).toBe("Budget 1")
  })

  it("close removes the matching gate", () => {
    const g = usePendingGatesStore.getState()
    g.open({
      key: { scope: "agent-team-budget", id: "run-1" },
      gateType: "budget",
      title: "B",
      runId: "run-1",
      teamId: "team-1",
    })
    g.close({ scope: "agent-team-budget", id: "run-1" })
    expect(usePendingGatesStore.getState().gates).toHaveLength(0)
  })

  it("clearForRun drops all gates for a runId", () => {
    const g = usePendingGatesStore.getState()
    g.open({
      key: { scope: "agent-team-budget", id: "run-1" },
      gateType: "budget",
      title: "B1",
      runId: "run-1",
      teamId: "team-1",
    })
    g.open({
      key: { scope: "agent-team-deadlock", id: "run-1" },
      gateType: "deadlock",
      title: "D1",
      runId: "run-1",
      teamId: "team-1",
    })
    g.open({
      key: { scope: "agent-team-budget", id: "run-2" },
      gateType: "budget",
      title: "B2",
      runId: "run-2",
      teamId: "team-1",
    })
    g.clearForRun("run-1")
    expect(usePendingGatesStore.getState().gates).toHaveLength(1)
    expect(usePendingGatesStore.getState().gates[0]?.runId).toBe("run-2")
  })

  it("gateTypeFromScope maps known scopes", () => {
    expect(gateTypeFromScope("agent-team-budget")).toBe("budget")
    expect(gateTypeFromScope("agent-team-deadlock")).toBe("deadlock")
    expect(gateTypeFromScope("agent-team-teammate-fix")).toBe("teammate_fix")
    expect(gateTypeFromScope("agent-team")).toBe("plan")
    expect(gateTypeFromScope("unknown")).toBe("plan")
  })
})
