import { allowedAgentTaskMoves, deriveDependencyStatus, guardAgentTaskMove } from "./state-machine"

describe("single-Agent task state machine", () => {
  it("keeps dependency blocking machine-owned", () => {
    expect(guardAgentTaskMove("pending", "blocked")).toEqual({
      allowed: false,
      reason: "dependency-owned",
    })
    expect(guardAgentTaskMove("blocked", "pending")).toEqual({
      allowed: false,
      reason: "dependency-owned",
    })
  })

  it("allows only explicit human-owned board moves", () => {
    expect(allowedAgentTaskMoves("pending")).toEqual(["cancelled"])
    expect(allowedAgentTaskMoves("in_progress")).toEqual(["paused", "cancelled"])
    expect(allowedAgentTaskMoves("review")).toEqual(["completed", "failed"])
    expect(allowedAgentTaskMoves("failed")).toEqual(["pending", "cancelled"])
    expect(allowedAgentTaskMoves("paused")).toEqual(["pending", "cancelled"])
    expect(allowedAgentTaskMoves("completed")).toEqual([])
  })

  it("derives blocked and unblocked states from dependency completion", () => {
    expect(deriveDependencyStatus("pending", ["completed", "in_progress"])).toBe("blocked")
    expect(deriveDependencyStatus("blocked", ["completed", "completed"])).toBe("pending")
    expect(deriveDependencyStatus("in_progress", ["failed"])).toBe("in_progress")
  })
})
