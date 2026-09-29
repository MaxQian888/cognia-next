import type { ProjectCoordinatorConfig } from "@/types"
import { resolveCoordinatorConfig } from "./config"
import { admitThreadCreation, admitThreadStart, startOfLocalDay } from "./admission"

const config = (coordinator?: ProjectCoordinatorConfig) => resolveCoordinatorConfig({ coordinator })

describe("admitThreadCreation", () => {
  it("refuses when disabled, paused or at the daily cap", () => {
    expect(admitThreadCreation({ config: config(undefined), createdToday: 0 })).toEqual({
      kind: "refuse",
      reason: "disabled",
    })
    expect(
      admitThreadCreation({ config: config({ enabled: true, paused: { at: 1 } }), createdToday: 0 })
    ).toEqual({ kind: "refuse", reason: "paused" })
    expect(
      admitThreadCreation({
        config: config({ enabled: true, preferences: { dailyThreadCap: 2 } }),
        createdToday: 2,
      })
    ).toEqual({ kind: "refuse", reason: "daily-cap" })
    expect(
      admitThreadCreation({
        config: config({ enabled: true, preferences: { dailyThreadCap: 2 } }),
        createdToday: 1,
      })
    ).toEqual({ kind: "allow" })
  })
})

describe("admitThreadStart", () => {
  it("stages coordinator starts under the soft limits", () => {
    expect(
      admitThreadStart({
        config: config({ enabled: true, preferences: { proposeBeforeStart: true } }),
        running: 0,
        requestedBy: "coordinator",
      })
    ).toEqual({ kind: "stage", reason: "propose-first" })
    expect(
      admitThreadStart({
        config: config({ enabled: true, preferences: { maxConcurrentThreads: 2 } }),
        running: 2,
        requestedBy: "coordinator",
      })
    ).toEqual({ kind: "stage", reason: "over-concurrency" })
    expect(
      admitThreadStart({
        config: config({ enabled: true, preferences: { maxConcurrentThreads: 2 } }),
        running: 1,
        requestedBy: "coordinator",
      })
    ).toEqual({ kind: "start" })
  })

  it("lets a person bypass soft limits but never the hard ones", () => {
    const soft = config({
      enabled: true,
      preferences: { proposeBeforeStart: true, maxConcurrentThreads: 1 },
    })
    expect(admitThreadStart({ config: soft, running: 5, requestedBy: "user" })).toEqual({
      kind: "start",
    })
    expect(
      admitThreadStart({
        config: config({ enabled: true, paused: { at: 1 } }),
        running: 0,
        requestedBy: "user",
      })
    ).toEqual({ kind: "refuse", reason: "paused" })
    expect(
      admitThreadStart({ config: config(undefined), running: 0, requestedBy: "user" })
    ).toEqual({ kind: "refuse", reason: "disabled" })
  })
})

describe("startOfLocalDay", () => {
  it("returns local midnight", () => {
    const noon = new Date(2026, 8, 29, 12, 30).getTime()
    expect(startOfLocalDay(noon)).toBe(new Date(2026, 8, 29).getTime())
  })
})
