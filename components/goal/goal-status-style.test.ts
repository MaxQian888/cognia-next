import { goalStatusChartColor, goalStatusStyle } from "./goal-status-style"
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

describe("goalStatusChartColor", () => {
  const ALL: GoalStatus[] = [
    "active",
    "paused",
    "completed",
    "stopped",
    "budget_limited",
    "turn_limited",
    "timed_out",
    "preempted",
  ]

  it("fills each status with its own tone's theme variable", () => {
    const toneVar = {
      active: "var(--success)",
      done: "var(--success)",
      paused: "var(--warning)",
      halted: "var(--destructive)",
      neutral: "var(--muted-foreground)",
    } as const
    for (const status of ALL) {
      expect(goalStatusChartColor(status).fill).toBe(toneVar[goalStatusStyle(status).tone])
    }
  })

  it("keeps completed on the success tone everywhere, not a palette slot", () => {
    expect(goalStatusChartColor("completed").fill).toBe("var(--success)")
  })

  it("tells apart active and completed, which share a tone, by opacity", () => {
    const active = goalStatusChartColor("active")
    const completed = goalStatusChartColor("completed")
    expect(active.fill).toBe(completed.fill)
    expect(active.opacity).toBe(1)
    expect(completed.opacity).toBeLessThan(active.opacity)
    expect(active).not.toEqual(completed)
  })

  it("tells apart the three limit exits from each other", () => {
    const limits = (["budget_limited", "turn_limited", "timed_out"] as const).map(
      goalStatusChartColor
    )
    expect(new Set(limits.map((c) => c.fill))).toEqual(new Set(["var(--destructive)"]))
    expect(new Set(limits.map((c) => c.opacity)).size).toBe(3)
  })

  it("tells apart stopped and preempted, which share the neutral tone", () => {
    expect(goalStatusChartColor("stopped").opacity).not.toBe(
      goalStatusChartColor("preempted").opacity
    )
  })

  it("returns an opacity within (0, 1] for every status", () => {
    for (const status of ALL) {
      const { opacity } = goalStatusChartColor(status)
      expect(opacity).toBeGreaterThan(0)
      expect(opacity).toBeLessThanOrEqual(1)
    }
  })

  it("falls back to the neutral tone at full opacity for an unknown status", () => {
    expect(goalStatusChartColor("from_the_future" as GoalStatus)).toEqual({
      fill: "var(--muted-foreground)",
      opacity: 1,
    })
  })
})
