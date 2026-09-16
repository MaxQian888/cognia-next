import { SPEC_MOCK_REGISTRY } from "../fake/mock-registry"
import { FakeProvider, sequenceScript, type FakeStep } from "../fake/fake-provider"
import { MemoryCallLedger } from "../fake/memory-ledger"
import {
  BudgetRefusedError,
  CallFailedError,
  CallOutcomeUnknownError,
  PolicyRefusalError,
  WorkflowError,
  performDurableCall,
  type DurableCallPorts,
} from "./durable-call"
import type { WorkflowEvent } from "./ports"

function setup(
  steps: FakeStep[],
  options: { cap?: number; maxModelCalls?: number; now?: () => number } = {}
) {
  const ledger = new MemoryCallLedger({
    capMicrousd: options.cap ?? 1_000_000,
    maxModelCalls: options.maxModelCalls ?? 24,
    deployments: Object.fromEntries(SPEC_MOCK_REGISTRY.deployments.map((d) => [d.id, d])),
    rateCards: Object.fromEntries(SPEC_MOCK_REGISTRY.rate_cards.map((c) => [c.id, c])),
  })
  const provider = new FakeProvider(sequenceScript(steps))
  const events: WorkflowEvent[] = []
  const sleeps: number[] = []
  const ports: DurableCallPorts = {
    ledger,
    executor: provider,
    events: { emit: async (event) => void events.push(event) },
    clock: { now: options.now ?? (() => 0) },
    sleep: async (ms) => void sleeps.push(ms),
  }
  return { ledger, provider, events, sleeps, ports }
}

function input(overrides: Partial<Parameters<typeof performDurableCall>[1]> = {}) {
  return {
    runId: "run-1",
    logicalStepId: "direct:solver",
    role: "solver",
    deploymentId: "fake-baseline",
    reserveMicrousd: 10_000,
    transportAttempts: 2,
    deadlineAt: 1_000_000,
    request: {
      messages: [{ role: "user" as const, content: "hello there" }],
      maxOutputTokens: 256,
      toolPolicyId: null,
    },
    signal: new AbortController().signal,
    ...overrides,
  }
}

describe("performDurableCall", () => {
  it("reserves, dispatches and settles a successful call exactly once", async () => {
    const { ledger, ports, events } = setup([{ kind: "text", text: "general kenobi" }])
    const result = await performDurableCall(ports, input())
    expect(result).toMatchObject({ text: "general kenobi", replayed: false, attempts: 1 })
    expect(ledger.attempts.map((a) => a.state)).toEqual(["SUCCEEDED"])
    expect(ledger.state.activeReservationsMicrousd).toBe(0)
    expect(ledger.state.spentMicrousd).toBeGreaterThan(0)
    expect(events.map((e) => e.type)).toEqual(["call.started", "call.finished"])
  })

  it("[ACC:REC-01] replays a committed result instead of calling again", async () => {
    const { ledger, ports, provider } = setup([{ kind: "text", text: "once" }])
    await performDurableCall(ports, input())
    const spent = ledger.state.spentMicrousd
    const replay = await performDurableCall(ports, input())
    expect(replay).toMatchObject({ text: "once", replayed: true })
    expect(provider.requests).toHaveLength(1)
    expect(ledger.state.spentMicrousd).toBe(spent)
  })

  it("retries an explicit 429 within the transport attempt bound, honouring Retry-After", async () => {
    const { ledger, ports, sleeps } = setup([
      { kind: "rate_limited", retryAfterMs: 250 },
      { kind: "text", text: "ok" },
    ])
    const result = await performDurableCall(ports, input())
    expect(result.attempts).toBe(2)
    expect(sleeps).toEqual([250])
    expect(ledger.attempts.map((a) => [a.attemptNo, a.state])).toEqual([
      [1, "FAILED"],
      [2, "SUCCEEDED"],
    ])
    expect(ledger.state.modelCalls).toBe(2)
  })

  it("stops after the bounded number of transport attempts", async () => {
    const { ports, ledger } = setup([{ kind: "server_error" }])
    await expect(performDurableCall(ports, input())).rejects.toBeInstanceOf(CallFailedError)
    expect(ledger.attempts).toHaveLength(2)
  })

  it("[ACC:BUD-06] turns a sent-and-silent call into UNKNOWN, keeps the money and never retries", async () => {
    const { ports, ledger, provider } = setup([
      { kind: "timeout_after_send" },
      { kind: "text", text: "never" },
    ])
    await expect(performDurableCall(ports, input())).rejects.toBeInstanceOf(CallOutcomeUnknownError)
    expect(provider.requests).toHaveLength(1)
    expect(ledger.attempts[0].state).toBe("UNKNOWN")
    expect(ledger.state.activeReservationsMicrousd).toBe(10_000)
  })

  it("never re-sends a step whose earlier attempt went unanswered, even on a replay", async () => {
    const { ports, ledger, provider } = setup([
      { kind: "timeout_after_send" },
      { kind: "text", text: "a second bill" },
    ])
    await expect(performDurableCall(ports, input())).rejects.toBeInstanceOf(CallOutcomeUnknownError)
    // A restarted worker drives the same graph again: the step is not re-sent.
    const replay = performDurableCall(ports, input())
    await expect(replay).rejects.toBeInstanceOf(CallOutcomeUnknownError)
    await expect(replay).rejects.toMatchObject({ details: { attemptId: "step:direct:solver" } })
    expect(provider.requests).toHaveLength(1)
    expect(ledger.attempts).toHaveLength(1)
  })

  it("reserves its own money when the stage it was meant to convert is already gone", async () => {
    const { ports, ledger, provider } = setup([{ kind: "text", text: "ok" }])
    await ledger.reserveStage("tail", 10_000)
    await ledger.releaseStage("tail")
    const result = await performDurableCall(ports, input({ fromStageId: "tail" }))
    expect(result.text).toBe("ok")
    expect(provider.requests).toHaveLength(1)
    expect(ledger.stages.get("tail")?.state).toBe("released")
  })

  it("still refuses a call the run cannot pay for once the stage is gone", async () => {
    const { ports, ledger, provider } = setup([{ kind: "text", text: "never" }], { cap: 10_000 })
    await ledger.reserveStage("tail", 10_000)
    await ledger.releaseStage("tail")
    await expect(
      performDurableCall(ports, input({ fromStageId: "tail", reserveMicrousd: 20_000 }))
    ).rejects.toMatchObject({ code: "RUN_BUDGET_EXHAUSTED" })
    expect(provider.requests).toHaveLength(0)
  })

  it("treats an adapter crash as UNKNOWN, not as a free failure", async () => {
    const { ports, ledger } = setup([{ kind: "throw" }])
    await expect(performDurableCall(ports, input())).rejects.toBeInstanceOf(CallOutcomeUnknownError)
    expect(ledger.attempts[0].state).toBe("UNKNOWN")
  })

  it("[ACC:CAS-04] ends on a policy refusal, bills it, and does not retry", async () => {
    const { ports, ledger, provider } = setup([
      { kind: "refusal" },
      { kind: "text", text: "bypass" },
    ])
    await expect(performDurableCall(ports, input())).rejects.toBeInstanceOf(PolicyRefusalError)
    expect(provider.requests).toHaveLength(1)
    expect(ledger.attempts[0].state).toBe("FAILED")
    expect(ledger.state.spentMicrousd).toBeGreaterThan(0)
  })

  it("settles a never-sent attempt as a free failure that still used its model-call slot, then retries", async () => {
    const { ports, ledger } = setup([{ kind: "not_sent" }, { kind: "text", text: "second" }])
    const result = await performDurableCall(ports, input())
    expect(result.text).toBe("second")
    expect(ledger.attempts.map((a) => a.state)).toEqual(["FAILED", "SUCCEEDED"])
    expect(ledger.attempts[0].actualMicrousd).toBe(0)
    expect(ledger.state.modelCalls).toBe(2)
  })

  it("surfaces ledger refusals before any request is sent", async () => {
    const { ports, provider } = setup([{ kind: "text", text: "x" }], { cap: 100 })
    await expect(performDurableCall(ports, input())).rejects.toBeInstanceOf(BudgetRefusedError)
    expect(provider.requests).toHaveLength(0)
  })

  it("refuses to start after the deadline or once cancelled", async () => {
    const late = setup([{ kind: "text", text: "x" }], { now: () => 2_000_000 })
    await expect(performDurableCall(late.ports, input())).rejects.toMatchObject({
      code: "DEADLINE_EXCEEDED",
    })
    const controller = new AbortController()
    controller.abort()
    const cancelled = setup([{ kind: "text", text: "x" }])
    await expect(
      performDurableCall(cancelled.ports, input({ signal: controller.signal }))
    ).rejects.toBeInstanceOf(WorkflowError)
    expect(cancelled.provider.requests).toHaveLength(0)
  })

  it("[ACC:BUD-06] keeps the money of a call cancelled in flight, whether or not usage came back", async () => {
    const silent = setup([])
    silent.ports.executor = {
      call: async () => ({
        outcome: "error",
        errorClass: "cancelled",
        message: "aborted in flight",
      }),
    }
    await expect(performDurableCall(silent.ports, input())).rejects.toMatchObject({
      code: "CANCELLED",
    })
    // No proof it went unbilled, so the reservation is held as UNKNOWN.
    expect(silent.ledger.attempts[0].state).toBe("UNKNOWN")

    const billed = setup([])
    billed.ports.executor = {
      call: async () => ({
        outcome: "error",
        errorClass: "cancelled",
        message: "aborted after the answer started",
        usage: { inputTokens: 100, outputTokens: 10 },
        semantics: {
          inputIncludesCacheRead: true,
          inputIncludesCacheWrite: false,
          outputIncludesReasoning: true,
        },
        providerRequestId: "mock:billed",
      }),
    }
    await expect(performDurableCall(billed.ports, input())).rejects.toMatchObject({
      code: "CANCELLED",
    })
    // A bill arrived, so the attempt settles as failed rather than staying open.
    expect(billed.ledger.attempts[0].state).toBe("FAILED")
    expect(billed.ledger.rows.some((r) => r.kind === "settle")).toBe(true)
  })

  it("treats a thrown non-Error the same as a crash", async () => {
    const { ledger, ports } = setup([])
    ports.executor = {
      call: async () => {
        throw "adapter exploded"
      },
    }
    await expect(performDurableCall(ports, input())).rejects.toBeInstanceOf(CallOutcomeUnknownError)
    expect(ledger.attempts[0].state).toBe("UNKNOWN")
  })

  it("retries a 429 with no Retry-After immediately, without sleeping", async () => {
    const { ports, sleeps, provider } = setup([
      { kind: "rate_limited" },
      { kind: "text", text: "second time lucky" },
    ])
    const result = await performDurableCall(ports, input())
    expect(result.text).toBe("second time lucky")
    expect(sleeps).toEqual([])
    expect(provider.requests).toHaveLength(2)
  })

  it("does not wait past the deadline for a Retry-After", async () => {
    let now = 0
    const { ports, sleeps } = setup([{ kind: "rate_limited", retryAfterMs: 5_000 }], {
      now: () => now,
    })
    now = 999_000
    await expect(performDurableCall(ports, input())).rejects.toBeInstanceOf(CallFailedError)
    expect(sleeps).toEqual([])
  })
})
