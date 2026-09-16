import { usdToMicrousd } from "../money/microusd"
import {
  applyTenantRelease,
  applyTenantSpend,
  planCallReservation,
  planMarkUncertain,
  planReleaseReservation,
  planRunCreation,
  planSettle,
  planStageReservation,
  planTerminalRelease,
  runAvailableMicrousd,
  tenantAvailableMicrousd,
  type RunBudgetState,
} from "./planner"

const usd = usdToMicrousd

function newRun(cap = "1", maxModelCalls = 24): RunBudgetState {
  const plan = planRunCreation(
    { limitRemainingMicrousd: null, activeHoldsMicrousd: 0 },
    { capMicrousd: usd(cap), maxModelCalls }
  )
  if (!plan.ok) throw new Error("setup")
  return plan.run
}

function ok<T>(plan: ({ ok: true } & T) | { ok: false; code: string }): T {
  if (!plan.ok) throw new Error(`unexpected refusal ${plan.code}`)
  return plan
}

describe("two-level budget planner", () => {
  it("[ACC:BUD-01] holds the whole run cap so a second run cannot share the same money", () => {
    const tenant = { limitRemainingMicrousd: usd("1"), activeHoldsMicrousd: 0 }
    const first = ok(planRunCreation(tenant, { capMicrousd: usd("1"), maxModelCalls: 24 }))
    const second = planRunCreation(first.tenant, { capMicrousd: usd("1"), maxModelCalls: 24 })
    expect(second).toMatchObject({
      ok: false,
      code: "TENANT_BUDGET_EXHAUSTED",
      availableMicrousd: 0,
    })
    expect(tenantAvailableMicrousd(first.tenant)).toBe(0)
  })

  it("lets an explicit single-run grant exceed the tenant limit", () => {
    const tenant = { limitRemainingMicrousd: usd("0.2"), activeHoldsMicrousd: 0 }
    expect(planRunCreation(tenant, { capMicrousd: usd("0.5"), maxModelCalls: 24 }).ok).toBe(false)
    expect(
      planRunCreation(tenant, {
        capMicrousd: usd("0.5"),
        maxModelCalls: 24,
        grantMicrousd: usd("0.3"),
      }).ok
    ).toBe(true)
  })

  it("[ACC:BUD-11] slices the run cap without touching the tenant twice", () => {
    let run = newRun("1")
    const a = ok(planCallReservation(run, usd("0.2")))
    run = a.next
    const b = ok(planCallReservation(run, usd("0.3")))
    run = b.next
    expect(runAvailableMicrousd(run)).toBe(usd("0.5"))

    const settled = ok(planSettle(run, a.reservation, usd("0.1")))
    run = settled.next
    expect(run.spentMicrousd).toBe(usd("0.1"))
    expect(run.activeReservationsMicrousd).toBe(usd("0.3"))
    expect(runAvailableMicrousd(run)).toBe(usd("0.6"))
    expect(run.tenantHoldMicrousd).toBe(usd("0.9"))
    expect(settled.adjustmentMicrousd).toBe(-usd("0.1"))
    expect(run.frozen).toBe(false)
  })

  it("[ACC:BUD-12] converts a reserved stage into a call reservation instead of adding the same amount", () => {
    let run = newRun("1")
    const stage = ok(planStageReservation(run, usd("0.3")))
    run = stage.next
    expect(run.activeReservationsMicrousd).toBe(usd("0.3"))

    const judge = ok(planCallReservation(run, usd("0.25"), stage.reservation))
    expect(judge.next.activeReservationsMicrousd).toBe(usd("0.3"))
    expect(judge.stage).toEqual({ kind: "stage", amountMicrousd: usd("0.05"), state: "held" })
    expect(judge.next.modelCalls).toBe(1)

    const synth = ok(planCallReservation(judge.next, usd("0.1"), judge.stage))
    // 0.05 covered by the stage, 0.05 extra from the run.
    expect(synth.next.activeReservationsMicrousd).toBe(usd("0.35"))
    expect(synth.stage?.state).toBe("converted")
  })

  it("[ACC:BUD-02] refuses to start a stage the run cannot afford", () => {
    const run = ok(planCallReservation(newRun("0.5"), usd("0.4"))).next
    expect(planStageReservation(run, usd("0.2"))).toMatchObject({
      ok: false,
      code: "RUN_BUDGET_EXHAUSTED",
      availableMicrousd: usd("0.1"),
    })
  })

  it("[ACC:BUD-10] admits at most one more call at 23 of 24", () => {
    let run = newRun("1", 24)
    for (let i = 0; i < 23; i++) run = ok(planCallReservation(run, 0)).next
    const first = planCallReservation(run, 0)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(planCallReservation(first.next, 0)).toMatchObject({ ok: false, code: "MAX_MODEL_CALLS" })
  })

  it("[ACC:BUD-09] books a bill above the conservative reservation in full and freezes the run", () => {
    let run = newRun("1")
    const call = ok(planCallReservation(run, usd("0.1")))
    const settled = ok(planSettle(call.next, call.reservation, usd("0.25")))
    run = settled.next
    expect(run.spentMicrousd).toBe(usd("0.25"))
    expect(run.overspendMicrousd).toBe(usd("0.15"))
    expect(settled.overspendDeltaMicrousd).toBe(usd("0.15"))
    expect(run.frozen).toBe(true)
    expect(planCallReservation(run, 0)).toMatchObject({ ok: false, code: "BUDGET_FROZEN" })
  })

  it("never drives the tenant hold negative when spend exceeds it", () => {
    const run = { ...newRun("1"), tenantHoldMicrousd: usd("0.05") }
    const call = ok(planCallReservation(run, usd("0.1")))
    const settled = ok(planSettle(call.next, call.reservation, usd("0.08")))
    expect(settled.next.tenantHoldMicrousd).toBe(0)
    expect(settled.tenantHoldConsumedMicrousd).toBe(usd("0.05"))
  })

  it("[ACC:BUD-06] keeps an uncertain reservation held through terminal release", () => {
    let run = newRun("1")
    const call = ok(planCallReservation(run, usd("0.2")))
    run = call.next
    const uncertain = ok(planMarkUncertain(call.reservation)).reservation
    expect(uncertain.state).toBe("uncertain")
    expect(planReleaseReservation(run, uncertain, { returnModelCall: true })).toMatchObject({
      ok: false,
      code: "RESERVATION_NOT_ACTIVE",
    })
    const released = planTerminalRelease(run, uncertain.amountMicrousd)
    expect(released.next.tenantHoldMicrousd).toBe(usd("0.2"))
    expect(released.releasedMicrousd).toBe(usd("0.8"))
    expect(released.next.terminal).toBe(true)
    expect(planCallReservation(released.next, 0)).toMatchObject({ ok: false, code: "RUN_TERMINAL" })
  })

  it("[ACC:BUD-07] settles late usage for an uncertain call after the run ended", () => {
    const run = newRun("1")
    const call = ok(planCallReservation(run, usd("0.2")))
    const uncertain = ok(planMarkUncertain(call.reservation)).reservation
    const terminal = planTerminalRelease(call.next, uncertain.amountMicrousd).next
    const late = ok(planSettle(terminal, uncertain, usd("0.12")))
    expect(late.next.spentMicrousd).toBe(usd("0.12"))
    expect(late.next.tenantHoldMicrousd).toBe(usd("0.08"))
    expect(late.next.terminal).toBe(true)
    // The leftover 0.08 is released on the follow-up terminal pass with nothing uncertain left.
    expect(planTerminalRelease(late.next, 0).releasedMicrousd).toBe(usd("0.08"))
  })

  it("returns a model-call slot only for a call proved unsent", () => {
    const run = newRun("1")
    const call = ok(planCallReservation(run, usd("0.1")))
    const abandoned = ok(
      planReleaseReservation(call.next, call.reservation, { returnModelCall: true })
    )
    expect(abandoned.next.modelCalls).toBe(0)
    expect(abandoned.next.activeReservationsMicrousd).toBe(0)
    const failedNoRefund = ok(
      planReleaseReservation(call.next, call.reservation, { returnModelCall: false })
    )
    expect(failedNoRefund.next.modelCalls).toBe(1)
    const stage = ok(planStageReservation(run, usd("0.1")))
    expect(
      ok(planReleaseReservation(stage.next, stage.reservation, { returnModelCall: true })).next
        .modelCalls
    ).toBe(0)
  })

  it("rejects settling a reservation twice and stage conversion from a non-stage", () => {
    const run = newRun("1")
    const call = ok(planCallReservation(run, usd("0.1")))
    const settled = ok(planSettle(call.next, call.reservation, usd("0.05")))
    expect(planSettle(settled.next, settled.reservation, usd("0.05"))).toMatchObject({
      ok: false,
      code: "RESERVATION_NOT_ACTIVE",
    })
    expect(planCallReservation(run, usd("0.1"), call.reservation)).toMatchObject({
      ok: false,
      code: "STAGE_NOT_HELD",
    })
    expect(planMarkUncertain(settled.reservation)).toMatchObject({ ok: false })
  })

  it("updates the tenant on spend and release", () => {
    const tenant = { limitRemainingMicrousd: usd("5"), activeHoldsMicrousd: usd("1") }
    const spent = applyTenantSpend(tenant, {
      actualMicrousd: usd("0.3"),
      tenantHoldConsumedMicrousd: usd("0.3"),
    })
    expect(spent).toEqual({ limitRemainingMicrousd: usd("4.7"), activeHoldsMicrousd: usd("0.7") })
    expect(applyTenantRelease(spent, usd("0.7")).activeHoldsMicrousd).toBe(0)
    expect(
      applyTenantSpend(
        { limitRemainingMicrousd: null, activeHoldsMicrousd: 5 },
        { actualMicrousd: 2, tenantHoldConsumedMicrousd: 2 }
      )
    ).toEqual({
      limitRemainingMicrousd: null,
      activeHoldsMicrousd: 3,
    })
    // A damaged account row never turns into budget that was never held; spend is not floored.
    expect(
      applyTenantRelease({ limitRemainingMicrousd: null, activeHoldsMicrousd: 5 }, 8)
        .activeHoldsMicrousd
    ).toBe(0)
    expect(
      applyTenantSpend(
        { limitRemainingMicrousd: 1, activeHoldsMicrousd: 0 },
        { actualMicrousd: 4, tenantHoldConsumedMicrousd: 4 }
      )
    ).toEqual({ limitRemainingMicrousd: -3, activeHoldsMicrousd: 0 })
    expect(() =>
      applyTenantRelease({ limitRemainingMicrousd: null, activeHoldsMicrousd: 5 }, -1)
    ).toThrow(RangeError)
  })

  it("follows the step-reservation machine for every state change it plans", () => {
    const run = newRun()
    for (const state of ["settled", "released", "converted"] as const) {
      const snapshot = { kind: "call" as const, amountMicrousd: 10, state }
      expect(planReleaseReservation(run, snapshot, { returnModelCall: true })).toMatchObject({
        ok: false,
      })
      expect(planMarkUncertain(snapshot)).toMatchObject({ ok: false })
      expect(planSettle(run, snapshot, 10)).toMatchObject({
        ok: false,
        code: "RESERVATION_NOT_ACTIVE",
      })
    }
    const uncertain = { kind: "call" as const, amountMicrousd: 10, state: "uncertain" as const }
    // Uncertain money waits for its bill: it settles, it is never released or re-marked.
    expect(planReleaseReservation(run, uncertain, { returnModelCall: true })).toMatchObject({
      ok: false,
    })
    expect(planMarkUncertain(uncertain)).toMatchObject({ ok: false })
    expect(planSettle(run, uncertain, 10)).toMatchObject({
      ok: true,
      reservation: { state: "settled" },
    })
    expect(
      planCallReservation(run, 5, { kind: "stage", amountMicrousd: 10, state: "uncertain" })
    ).toMatchObject({ ok: false, code: "STAGE_NOT_HELD" })
  })

  it("rejects non-integer amounts loudly", () => {
    expect(() => planCallReservation(newRun(), 0.5)).toThrow(RangeError)
    expect(() => planTerminalRelease(newRun(), -1)).toThrow(RangeError)
  })
})
