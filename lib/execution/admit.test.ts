import { ExecutionBroker } from "./broker"
import { combineAbortSignals, runWithExecutionLease } from "./admit"
import type { ExecutionLeaseRequest } from "./types"

const req = (o: Partial<ExecutionLeaseRequest> = {}): ExecutionLeaseRequest => ({
  kind: "subagent",
  label: "t",
  ...o,
})

describe("combineAbortSignals", () => {
  it("returns undefined when no signal supplied", () => {
    expect(combineAbortSignals(undefined, null)).toBeUndefined()
  })

  it("passes a single signal through unchanged", () => {
    const c = new AbortController()
    const combined = combineAbortSignals(c.signal)
    expect(combined?.signal).toBe(c.signal)
    combined?.cleanup()
  })

  it("aborts when the first of several aborts", () => {
    const a = new AbortController()
    const b = new AbortController()
    const combined = combineAbortSignals(a.signal, b.signal)!
    expect(combined.signal.aborted).toBe(false)
    b.abort()
    expect(combined.signal.aborted).toBe(true)
    combined.cleanup()
  })

  it("is pre-aborted when an input is already aborted", () => {
    const a = new AbortController()
    a.abort()
    const b = new AbortController()
    const combined = combineAbortSignals(a.signal, b.signal)!
    expect(combined.signal.aborted).toBe(true)
    combined.cleanup()
  })

  it("cleanup detaches listeners so a later abort does not propagate", () => {
    const a = new AbortController()
    const b = new AbortController()
    const combined = combineAbortSignals(a.signal, b.signal)!
    combined.cleanup()
    a.abort()
    expect(combined.signal.aborted).toBe(false)
  })
})

describe("runWithExecutionLease", () => {
  it("acquires, runs, and releases ok on success", async () => {
    const broker = new ExecutionBroker({ limits: { "ai-turn": 1 } })
    const result = await runWithExecutionLease(
      req(),
      async (lease) => {
        expect(lease.signal).toBeDefined()
        expect(broker.countRunning()).toBe(1)
        return 42
      },
      broker
    )
    expect(result).toBe(42)
    expect(broker.countRunning()).toBe(0)
  })

  it("releases as error and re-throws on failure", async () => {
    const broker = new ExecutionBroker({ limits: { "ai-turn": 1 } })
    await expect(
      runWithExecutionLease(
        req(),
        async () => {
          throw new Error("boom")
        },
        broker
      )
    ).rejects.toThrow("boom")
    expect(broker.countRunning()).toBe(0)
  })

  it("releases as cancelled when the lease is cancelled mid-run", async () => {
    const broker = new ExecutionBroker({ limits: { "ai-turn": 1 } })
    const events: string[] = []
    broker.onEvent((e) => {
      if (e.type === "leg-completed") events.push(e.outcome)
    })
    await expect(
      runWithExecutionLease(
        req({ sessionId: "s" }),
        async (lease) => {
          broker.cancelBySession("s")
          expect(lease.signal.aborted).toBe(true)
          expect(lease.cancelled).toBe(true)
          throw new Error("aborted")
        },
        broker
      )
    ).rejects.toThrow()
    expect(events).toEqual(["cancelled"])
    expect(broker.countRunning()).toBe(0)
  })

  it("uses the global singleton when no broker is passed", async () => {
    // Smoke: resolves against the default singleton without throwing.
    const out = await runWithExecutionLease(req(), async () => "done")
    expect(out).toBe("done")
  })
})
