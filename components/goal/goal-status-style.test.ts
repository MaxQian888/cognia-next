import { goalStatusStyle } from "./goal-status-style"
import type { GoalStatus } from "@/types/goal"

describe("goalStatusStyle", () => {
  it("maps active to the success tone with a pulsing dot", () => {
    const s = goalStatusStyle("active")
    expect(s.tone).toBe("active")
    expect(s.pulse).toBe(true)
    expect(s.dot).toContain("success")
  })

  it("maps paused to the warning tone (no pulse)", () => {
    const s = goalStatusStyle("paused")
    expect(s.tone).toBe("paused")
    expect(s.pulse).toBe(false)
    expect(s.text).toContain("warning")
  })

  it("maps budget/turn/timeout exits to the halted (destructive) tone", () => {
    for (const status of ["budget_limited", "turn_limited", "timed_out"] as GoalStatus[]) {
      const s = goalStatusStyle(status)
      expect(s.tone).toBe("halted")
      expect(s.bar).toContain("destructive")
    }
  })

  it("maps completed to the done tone", () => {
    expect(goalStatusStyle("completed").tone).toBe("done")
  })

  it("maps stopped/preempted to the neutral tone", () => {
    expect(goalStatusStyle("stopped").tone).toBe("neutral")
    expect(goalStatusStyle("preempted").tone).toBe("neutral")
  })

  it("returns a defined style for every GoalStatus", () => {
    const all: GoalStatus[] = [
      "active",
      "paused",
      "completed",
      "stopped",
      "budget_limited",
      "turn_limited",
      "timed_out",
      "preempted",
    ]
    for (const status of all) {
      const s = goalStatusStyle(status)
      expect(s.rail).toBeTruthy()
      expect(s.chip).toBeTruthy()
    }
  })
})
