import { SPEC_MOCK_REGISTRY } from "./mock-registry"
import { MemoryCallLedger, type MemoryLedgerOptions } from "./memory-ledger"
import type { PrepareCallInput, SettleCallInput } from "../workflows/ports"

const DEPLOYMENT = "fake-baseline"

function ledgerFor(overrides: Partial<MemoryLedgerOptions> = {}) {
  return new MemoryCallLedger({
    capMicrousd: 1_000_000,
    maxModelCalls: 4,
    deployments: Object.fromEntries(SPEC_MOCK_REGISTRY.deployments.map((d) => [d.id, d])),
    rateCards: Object.fromEntries(SPEC_MOCK_REGISTRY.rate_cards.map((c) => [c.id, c])),
    ...overrides,
  })
}

function prepareInput(overrides: Partial<PrepareCallInput> = {}): PrepareCallInput {
  return {
    runId: "run-1",
    logicalStepId: "direct:solver",
    role: "solver",
    deploymentId: DEPLOYMENT,
    reserveMicrousd: 10_000,
    requestHash: "hash-1",
    ...overrides,
  } as PrepareCallInput
}

const USAGE: SettleCallInput = {
  status: "succeeded",
  usage: { inputTokens: 1_000, outputTokens: 100 },
  semantics: {
    inputIncludesCacheRead: true,
    inputIncludesCacheWrite: false,
    outputIncludesReasoning: true,
  },
  providerRequestId: "mock:attempt-1",
}

/** An explicit failure that produced no bill at all. */
const FAILED_NO_BILL: SettleCallInput = {
  status: "failed",
  usage: null,
  semantics: null,
  providerRequestId: null,
}

async function granted(ledger: MemoryCallLedger, input = prepareInput()) {
  const outcome = await ledger.prepare(input)
  if (outcome.kind !== "granted") throw new Error(`refused: ${JSON.stringify(outcome)}`)
  return outcome
}

describe("MemoryCallLedger", () => {
  it("refuses to exist at all on a cap that is not an amount", () => {
    expect(() => ledgerFor({ capMicrousd: -1 })).toThrow(RangeError)
  })

  it("[ACC:BUD-10] refuses the call past the run's model-call limit", async () => {
    const ledger = ledgerFor({ maxModelCalls: 1 })
    await granted(ledger)
    await expect(
      ledger.prepare(prepareInput({ logicalStepId: "direct:second" }))
    ).resolves.toMatchObject({
      kind: "refused",
    })
  })

  it("reserves, dispatches and settles a call at the rate card's price", async () => {
    const ledger = ledgerFor()
    const { attemptId } = await granted(ledger)
    await ledger.markDispatched(attemptId)
    const settled = await ledger.settle(attemptId, USAGE)
    expect(settled.costStatus).toBe("actual")
    expect(settled.frozen).toBe(false)
    expect(settled.actualMicrousd).toBe(ledger.totalSettledMicrousd())
    expect(settled.actualMicrousd).toBeGreaterThan(0)
    const attempt = ledger.attempts[0]
    expect(attempt).toMatchObject({
      state: "SUCCEEDED",
      attemptNo: 1,
      providerRequestId: "mock:attempt-1",
    })
    expect(ledger.rows.map((r) => r.kind)).toEqual(["hold", "settle"])
  })

  it("[ACC:BUD-03] books one settlement per attempt, however often it is told", async () => {
    const ledger = ledgerFor()
    const { attemptId } = await granted(ledger)
    await ledger.markDispatched(attemptId)
    const first = await ledger.settle(attemptId, USAGE)
    const again = await ledger.settle(attemptId, USAGE)
    expect(again.actualMicrousd).toBe(first.actualMicrousd)
    expect(ledger.rows.filter((r) => r.kind === "settle")).toHaveLength(1)
    expect(ledger.totalSettledMicrousd()).toBe(first.actualMicrousd)
  })

  it("[ACC:REC-01] replays a committed step instead of buying it twice", async () => {
    const ledger = ledgerFor()
    const { attemptId } = await granted(ledger)
    await ledger.markDispatched(attemptId)
    await ledger.settle(attemptId, {
      ...USAGE,
      result: {
        text: "answer",
        providerRequestId: "mock:attempt-1",
        finishReason: "stop" as const,
      },
    })
    await expect(ledger.prepare(prepareInput())).resolves.toEqual({
      kind: "replay",
      result: {
        text: "answer",
        providerRequestId: "mock:attempt-1",
        finishReason: "stop" as const,
      },
    })
    expect(ledger.attempts).toHaveLength(1)
  })

  it("[ACC:AUTH-07] asks admission on every prepare and never reserves when it is denied", async () => {
    const ledger = ledgerFor({ admit: () => ({ kind: "refused", code: "RUN_TERMINAL" }) })
    await expect(ledger.prepare(prepareInput())).resolves.toEqual({
      kind: "refused",
      code: "RUN_TERMINAL",
    })
    expect(ledger.attempts).toHaveLength(0)
  })

  it("refuses the call that would break the run cap", async () => {
    const ledger = ledgerFor({ capMicrousd: 5_000 })
    const outcome = await ledger.prepare(prepareInput({ reserveMicrousd: 10_000 }))
    expect(outcome.kind).toBe("refused")
  })

  it("numbers a retry of the same step as its next attempt", async () => {
    const ledger = ledgerFor()
    const first = await granted(ledger)
    await ledger.markDispatched(first.attemptId)
    await ledger.settle(first.attemptId, FAILED_NO_BILL)
    const second = await granted(ledger)
    expect(ledger.attempts.map((a) => a.attemptNo)).toEqual([1, 2])
    expect(second.attemptId).not.toBe(first.attemptId)
  })

  it("books an explicit failure with no bill at zero, and an UNKNOWN one at its reservation", async () => {
    const failed = ledgerFor()
    const a = await granted(failed)
    await failed.markDispatched(a.attemptId)
    expect(await failed.settle(a.attemptId, FAILED_NO_BILL)).toMatchObject({
      actualMicrousd: 0,
      costStatus: "actual",
    })
    expect(failed.attempts[0].state).toBe("FAILED")

    const unknown = ledgerFor()
    const b = await granted(unknown)
    await unknown.markDispatched(b.attemptId)
    await unknown.markUnknown(b.attemptId)
    expect(unknown.attempts[0].state).toBe("UNKNOWN")
    expect(unknown.rows.map((r) => r.kind)).toEqual(["hold", "unknown"])
    // Late usage reconciles the same attempt rather than opening a new one.
    expect(await unknown.settle(b.attemptId, FAILED_NO_BILL)).toMatchObject({
      actualMicrousd: 10_000,
      costStatus: "estimated",
    })
    expect(unknown.attempts[0].state).toBe("RECONCILED")
  })

  it("prices a deployment with no rate card at the configured unknown-price amount", async () => {
    const ledger = ledgerFor({ deployments: {}, unknownPriceActualMicrousd: 7_777 })
    const { attemptId } = await granted(ledger)
    await ledger.markDispatched(attemptId)
    expect(await ledger.settle(attemptId, USAGE)).toMatchObject({
      actualMicrousd: 7_777,
      costStatus: "estimated",
    })

    const fallback = ledgerFor({ deployments: {} })
    const second = await granted(fallback)
    await fallback.markDispatched(second.attemptId)
    // With no configured amount the reservation itself is the estimate.
    expect(await fallback.settle(second.attemptId, USAGE)).toMatchObject({
      actualMicrousd: 10_000,
      costStatus: "estimated",
    })
  })

  it("[ACC:BUD-09] records the overspend of a call that cost more than it reserved", async () => {
    const ledger = ledgerFor({ capMicrousd: 12_000 })
    const { attemptId } = await granted(ledger)
    await ledger.markDispatched(attemptId)
    const settled = await ledger.settle(attemptId, {
      ...USAGE,
      usage: { inputTokens: 5_000_000, outputTokens: 500_000 },
    })
    expect(settled.frozen).toBe(true)
    expect(ledger.rows.map((r) => r.kind)).toEqual(["hold", "settle", "overspend"])
    expect(ledger.rows[2].amountMicrousd).toBeGreaterThan(0)
  })

  it("refuses to dispatch or mark unknown an attempt in the wrong state", async () => {
    const ledger = ledgerFor()
    const { attemptId } = await granted(ledger)
    await expect(ledger.markUnknown(attemptId)).rejects.toThrow("cannot mark PREPARED unknown")
    await ledger.markDispatched(attemptId)
    await expect(ledger.markDispatched(attemptId)).rejects.toThrow("cannot dispatch DISPATCHED")
    await expect(ledger.markDispatched("attempt-nope")).rejects.toThrow(
      "unknown attempt attempt-nope"
    )
  })

  it("[ACC:REC-02] gives back the money and the call slot of an attempt proved never sent", async () => {
    const ledger = ledgerFor({ maxModelCalls: 1 })
    const { attemptId } = await granted(ledger)
    await ledger.abandon(attemptId)
    expect(ledger.attempts[0].state).toBe("ABANDONED")
    expect(ledger.rows.map((r) => r.kind)).toEqual(["hold", "abandon"])
    // The slot came back, so the run can still make its one call.
    await expect(granted(ledger)).resolves.toBeTruthy()
    await expect(ledger.abandon(attemptId)).rejects.toThrow("cannot abandon ABANDONED")
  })

  it("[ACC:BUD-12] holds a stage and lets a call convert from it, then releases the rest", async () => {
    const ledger = ledgerFor()
    expect(await ledger.reserveStage("stage-1", 40_000)).toEqual({ kind: "granted" })
    expect(ledger.rows.map((r) => r.kind)).toEqual(["stage"])
    const converted = await granted(ledger, prepareInput({ fromStageId: "stage-1" }))
    expect(converted.attemptId).toBeTruthy()
    expect(ledger.stages.get("stage-1")?.amountMicrousd).toBe(30_000)

    await ledger.releaseStage("stage-1")
    expect(ledger.stages.get("stage-1")?.state).toBe("released")
    // Asking for a stage it already had does not charge the run again.
    const reservedBefore = ledger.state.activeReservationsMicrousd
    expect(await ledger.reserveStage("stage-1", 40_000)).toEqual({ kind: "granted" })
    expect(ledger.state.activeReservationsMicrousd).toBe(reservedBefore)
    // Releasing twice, or releasing a stage that never existed, is a no-op.
    await expect(ledger.releaseStage("stage-1")).resolves.toBeUndefined()
    await expect(ledger.releaseStage("stage-nope")).resolves.toBeUndefined()
  })

  it("refuses a stage the run cap cannot cover", async () => {
    const ledger = ledgerFor({ capMicrousd: 10_000 })
    expect(await ledger.reserveStage("stage-1", 40_000)).toMatchObject({ kind: "refused" })
    expect(ledger.stages.has("stage-1")).toBe(false)
  })
})
