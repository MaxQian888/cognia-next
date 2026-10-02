import { afterEach, describe, expect, it, vi } from "vitest"

import type { ProfileConfig } from "./config"
import { dueChecks, MinuteScheduler } from "./scheduler"

const native: ProfileConfig = {
  id: "native",
  origin: null,
  httpCadenceSeconds: 60,
  protocolCadenceSeconds: 60,
}
const web: ProfileConfig = {
  id: "web",
  origin: "https://cognia.cn",
  httpCadenceSeconds: null,
  protocolCadenceSeconds: 300,
}
const T0 = Date.UTC(2026, 9, 2, 10, 0, 0)

afterEach(() => {
  vi.useRealTimers()
})

describe("dueChecks", () => {
  it("runs 60 s classes every minute and 300 s classes on UTC five-minute marks", () => {
    expect(dueChecks(T0, native)).toEqual({ runHttp: true, runProtocol: true })
    expect(dueChecks(T0, web)).toEqual({ runHttp: false, runProtocol: true })
    for (let minute = 1; minute < 5; minute += 1) {
      expect(dueChecks(T0 + minute * 60_000, web)).toEqual({ runHttp: false, runProtocol: false })
      expect(dueChecks(T0 + minute * 60_000, native).runProtocol).toBe(true)
    }
    expect(dueChecks(T0 + 5 * 60_000, web).runProtocol).toBe(true)
  })

  it("supports independent HTTP and protocol cadences", () => {
    const mixed: ProfileConfig = { ...native, protocolCadenceSeconds: 120 }
    expect(dueChecks(T0 + 60_000, mixed)).toEqual({ runHttp: true, runProtocol: false })
    expect(dueChecks(T0 + 120_000, mixed)).toEqual({ runHttp: true, runProtocol: true })
  })
})

describe("MinuteScheduler", () => {
  it("never overlaps a profile; the skipped minute is reported as a gap", async () => {
    const runs: Array<[string, number]> = []
    const skips: Array<[string, number]> = []
    let release!: () => void
    const blocker = new Promise<void>((resolve) => (release = resolve))
    const scheduler = new MinuteScheduler({
      profiles: [native, web],
      onRun: async (profile, minute) => {
        runs.push([profile.id, minute])
        if (profile.id === "native" && minute === T0) await blocker
      },
      onSkip: (profile, minute) => skips.push([profile.id, minute]),
    })
    scheduler.tick(T0)
    expect(scheduler.running.sort()).toEqual(["native", "web"])
    await new Promise((resolve) => setTimeout(resolve, 0))
    scheduler.tick(T0 + 60_000)
    expect(skips).toEqual([["native", T0 + 60_000]])
    release()
    await scheduler.idle()
    scheduler.tick(T0 + 120_000)
    await scheduler.idle()
    expect(runs).toEqual([
      ["native", T0],
      ["web", T0],
      ["native", T0 + 120_000],
    ])
  })

  it("keeps scheduling after a run rejects", async () => {
    const runs: number[] = []
    const scheduler = new MinuteScheduler({
      profiles: [native],
      onRun: async (_profile, minute) => {
        runs.push(minute)
        throw new Error("boom")
      },
      onSkip: () => undefined,
    })
    scheduler.tick(T0)
    await scheduler.idle()
    scheduler.tick(T0 + 60_000)
    await scheduler.idle()
    expect(runs).toEqual([T0, T0 + 60_000])
  })

  it("fires on UTC minute boundaries with the boundary as scheduledAt", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0 + 42_500)
    const minutes: number[] = []
    const scheduler = new MinuteScheduler({
      profiles: [native],
      onRun: async (_profile, minute) => {
        minutes.push(minute)
      },
      onSkip: () => undefined,
    })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(17_400)
    expect(minutes).toEqual([])
    await vi.advanceTimersByTimeAsync(200)
    expect(minutes).toEqual([T0 + 60_000])
    await vi.advanceTimersByTimeAsync(120_000)
    expect(minutes).toEqual([T0 + 60_000, T0 + 120_000, T0 + 180_000])
    scheduler.stop()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(minutes).toHaveLength(3)
  })

  it("reports minutes missed while suspended instead of running them late", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0 + 59_000)
    const minutes: number[] = []
    const missed: Array<[number, number]> = []
    const scheduler = new MinuteScheduler({
      profiles: [native],
      onRun: async (_profile, minute) => {
        minutes.push(minute)
      },
      onSkip: () => undefined,
      onMissed: (from, count) => missed.push([from, count]),
    })
    scheduler.start()
    // Jump the wall clock as a suspended host would, then let the timer fire.
    vi.setSystemTime(T0 + 4 * 60_000 + 3_000)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(missed).toEqual([[T0 + 60_000, 3]])
    expect(minutes).toEqual([T0 + 4 * 60_000])
    scheduler.stop()
  })
})
