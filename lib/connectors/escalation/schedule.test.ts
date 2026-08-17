const mockInfo = jest.fn()
jest.mock("@cognia/logging", () => {
  const actual = jest.requireActual<typeof import("@cognia/logging")>("@cognia/logging")
  return {
    ...actual,
    loggers: {
      ...actual.loggers,
      network: { ...actual.loggers.network, info: (...a: unknown[]) => mockInfo(...a) },
    },
  }
})
// The real sweep drags the bus / gateway graph in; the schedule only needs the seam.
jest.mock("./sweep", () => ({ sweepSlaEscalations: jest.fn() }))

import {
  SLA_ESCALATION_SWEEP_INITIAL_DELAY_MS,
  SLA_ESCALATION_SWEEP_INTERVAL_MS,
  startSlaEscalationSweep,
} from "./schedule"

/** Records timer registrations so the schedule can be driven synchronously. */
function fakeScheduler() {
  const timers: Array<{ cb: () => void; ms: number; kind: "timeout" | "interval" }> = []
  const cleared: string[] = []
  return {
    timers,
    cleared,
    scheduler: {
      setTimeout: (cb: () => void, ms: number) => {
        timers.push({ cb, ms, kind: "timeout" as const })
        return timers.length
      },
      clearTimeout: () => {
        cleared.push("timeout")
      },
      setInterval: (cb: () => void, ms: number) => {
        timers.push({ cb, ms, kind: "interval" as const })
        return timers.length
      },
      clearInterval: () => {
        cleared.push("interval")
      },
    },
  }
}

const EMPTY = { scanned: 0, escalated: 0, actions: 0, failures: 0, errors: 0 }

beforeEach(() => mockInfo.mockReset())

describe("startSlaEscalationSweep", () => {
  it("runs on a 60 s cadence after a 15 s boot delay and forwards deps to the sweep", async () => {
    const { timers, scheduler } = fakeScheduler()
    const sweep = jest.fn(async () => ({ ...EMPTY }))
    const deps = { now: () => 1 }
    const handle = startSlaEscalationSweep({ scheduler, sweep, deps })
    expect(timers[0]).toMatchObject({ kind: "timeout", ms: SLA_ESCALATION_SWEEP_INITIAL_DELAY_MS })
    expect(SLA_ESCALATION_SWEEP_INTERVAL_MS).toBe(60_000)
    expect(SLA_ESCALATION_SWEEP_INITIAL_DELAY_MS).toBe(15_000)
    await handle.runNow()
    expect(sweep).toHaveBeenCalledWith(deps)
    // Quiet ticks stay silent in the log.
    expect(mockInfo).not.toHaveBeenCalled()
    handle.dispose()
  })

  it("logs a summary when something escalated or failed", async () => {
    const { scheduler } = fakeScheduler()
    const sweep = jest.fn(async () => ({ ...EMPTY, scanned: 2, escalated: 1 }))
    const handle = startSlaEscalationSweep({ scheduler, sweep, intervalMs: 5, initialDelayMs: 0 })
    await handle.runNow()
    expect(mockInfo).toHaveBeenCalledWith(
      "[sla-escalation] sweep",
      expect.objectContaining({ escalated: 1 })
    )
    handle.dispose()
  })

  it("falls back to the real sweep and real timers when neither is injected", async () => {
    const { sweepSlaEscalations } = jest.requireMock<typeof import("./sweep")>("./sweep")
    ;(sweepSlaEscalations as jest.Mock).mockResolvedValue({ ...EMPTY, failures: 1 })
    const handle = startSlaEscalationSweep()
    await handle.runNow()
    expect(sweepSlaEscalations).toHaveBeenCalledWith(undefined)
    expect(mockInfo).toHaveBeenCalledWith(
      "[sla-escalation] sweep",
      expect.objectContaining({ failures: 1 })
    )
    handle.dispose()
  })

  it("honours interval / delay overrides and disposes timers", () => {
    const { timers, cleared, scheduler } = fakeScheduler()
    const handle = startSlaEscalationSweep({
      scheduler,
      sweep: jest.fn(async () => ({ ...EMPTY })),
      intervalMs: 5_000,
      initialDelayMs: 0,
    })
    expect(timers[0]).toMatchObject({ kind: "timeout", ms: 0 })
    timers[0].cb()
    expect(timers.some((t) => t.kind === "interval" && t.ms === 5_000)).toBe(true)
    handle.dispose()
    expect(cleared.length).toBeGreaterThan(0)
  })
})
