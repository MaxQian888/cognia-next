import type { TaskExecution } from "@/types/scheduler"

import { formatPhaseDuration, measurePhase, recordPhase, summarizePhases } from "./execution-phases"

function execution(startedAtMs = 1_000): Pick<TaskExecution, "startedAt" | "phases"> {
  return { startedAt: new Date(startedAtMs) }
}

function clock(...ticks: number[]): () => number {
  const queue = [...ticks]
  return () => {
    const next = queue.shift()
    if (next === undefined) throw new Error("clock exhausted")
    return next
  }
}

describe("recordPhase", () => {
  it("records offsets relative to the execution start and appends in order", () => {
    const target = execution(1_000)
    recordPhase(target, "session", 1_010, 1_050)
    recordPhase(target, "turn", 1_050, 3_050)
    expect(target.phases).toEqual([
      { name: "session", startOffsetMs: 10, durationMs: 40 },
      { name: "turn", startOffsetMs: 50, durationMs: 2_000 },
    ])
  })

  it("allows a negative offset for a slice that began before execution (fire delay)", () => {
    const target = execution(1_000)
    recordPhase(target, "fire-delay", 400, 1_000)
    expect(target.phases).toEqual([{ name: "fire-delay", startOffsetMs: -600, durationMs: 600 }])
  })

  it("clamps a negative duration from clock skew to zero", () => {
    const target = execution(1_000)
    expect(recordPhase(target, "session", 1_100, 1_050).durationMs).toBe(0)
  })

  it("keeps the outcome only when one is given", () => {
    const target = execution(0)
    recordPhase(target, "environment-setup", 0, 5, "reused")
    recordPhase(target, "turn", 5, 6)
    expect(target.phases?.[0]).toHaveProperty("outcome", "reused")
    expect(target.phases?.[1]).not.toHaveProperty("outcome")
  })
})

describe("measurePhase", () => {
  it("returns the work's result and records its duration and outcome", async () => {
    const target = execution(0)
    const result = await measurePhase(target, "environment-setup", async () => ({ reused: true }), {
      now: clock(100, 130),
      outcome: (value) => (value.reused ? "reused" : undefined),
    })
    expect(result).toEqual({ reused: true })
    expect(target.phases).toEqual([
      { name: "environment-setup", startOffsetMs: 100, durationMs: 30, outcome: "reused" },
    ])
  })

  it("records the phase and rethrows when the work fails", async () => {
    const target = execution(0)
    await expect(
      measurePhase(
        target,
        "workspace-lease",
        async () => {
          throw new Error("lease refused")
        },
        { now: clock(10, 25) }
      )
    ).rejects.toThrow("lease refused")
    expect(target.phases).toEqual([{ name: "workspace-lease", startOffsetMs: 10, durationMs: 15 }])
  })
})

describe("summarizePhases / formatPhaseDuration", () => {
  it("renders a compact, ordered summary", () => {
    expect(
      summarizePhases([
        { name: "fire-delay", startOffsetMs: -12, durationMs: 12 },
        { name: "environment-setup", startOffsetMs: 0, durationMs: 3, outcome: "reused" },
        { name: "turn", startOffsetMs: 3, durationMs: 8_200 },
      ])
    ).toBe("fire-delay 12ms · environment-setup 3ms (reused) · turn 8.2s")
  })

  it("is empty when nothing was measured", () => {
    expect(summarizePhases(undefined)).toBe("")
    expect(summarizePhases([])).toBe("")
  })

  it("formats milliseconds, seconds and minutes without a 60-second carry bug", () => {
    expect(formatPhaseDuration(999)).toBe("999ms")
    expect(formatPhaseDuration(1_500)).toBe("1.5s")
    expect(formatPhaseDuration(125_000)).toBe("2m 5s")
    expect(formatPhaseDuration(119_700)).toBe("2m 0s")
  })
})
