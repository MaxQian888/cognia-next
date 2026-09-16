/**
 * Two-level budget arithmetic (DESIGN §13.2), as pure functions over value
 * snapshots. The host store runs each plan inside ONE read-write transaction
 * (lock order tenant → session → run → reservation → call) and persists the
 * returned `next` state plus the ledger rows the plan names. Nothing here
 * reads a clock, a database or a float.
 *
 *   run_available = run_cap − run_spent − Σ active reservations
 *
 * Level 1 (tenant hold): the whole run cap is held against the tenant when the
 * run is created, so parallel runs cannot spend the same money.
 * Level 2 (step reservations): calls and reserved stages slice the run cap;
 * they never touch the tenant again. Settlement books the ACTUAL cost in full,
 * even when it exceeds the reservation — the excess becomes overspend and the
 * run freezes; money is never dropped to keep a balance looking non-negative.
 */

import type { Microusd } from "../money/microusd"
import {
  canTransitionReservation,
  type StepReservationKind,
  type StepReservationState,
} from "../state/step-reservation"

export interface RunBudgetState {
  capMicrousd: Microusd
  spentMicrousd: Microusd
  activeReservationsMicrousd: Microusd
  tenantHoldMicrousd: Microusd
  overspendMicrousd: Microusd
  frozen: boolean
  modelCalls: number
  maxModelCalls: number
  terminal: boolean
}

export interface ReservationSnapshot {
  kind: StepReservationKind
  amountMicrousd: Microusd
  state: StepReservationState
}

export type BudgetRefusalCode =
  | "RUN_TERMINAL"
  | "BUDGET_FROZEN"
  | "MAX_MODEL_CALLS"
  | "RUN_BUDGET_EXHAUSTED"
  | "TENANT_BUDGET_EXHAUSTED"
  | "RESERVATION_NOT_ACTIVE"
  | "STAGE_NOT_HELD"

export interface BudgetRefusal {
  ok: false
  code: BudgetRefusalCode
  requestedMicrousd?: Microusd
  availableMicrousd?: Microusd
}

export type Plan<T> = ({ ok: true } & T) | BudgetRefusal

function refuse(
  code: BudgetRefusalCode,
  requested?: Microusd,
  available?: Microusd
): BudgetRefusal {
  return {
    ok: false,
    code,
    ...(requested !== undefined ? { requestedMicrousd: requested } : {}),
    ...(available !== undefined ? { availableMicrousd: available } : {}),
  }
}

function assertAmount(amount: Microusd, field: string): void {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer microusd, got ${amount}`)
  }
}

export function runAvailableMicrousd(state: RunBudgetState): Microusd {
  const available = state.capMicrousd - state.spentMicrousd - state.activeReservationsMicrousd
  return available > 0 ? available : 0
}

// ── tenant level ────────────────────────────────────────────────────────────

export interface TenantBudgetState {
  /** Remaining allowance before holds for the tightest applicable scope; null = no tenant limit. */
  limitRemainingMicrousd: Microusd | null
  activeHoldsMicrousd: Microusd
}

export function tenantAvailableMicrousd(tenant: TenantBudgetState): Microusd | null {
  if (tenant.limitRemainingMicrousd === null) return null
  const available = tenant.limitRemainingMicrousd - tenant.activeHoldsMicrousd
  return available > 0 ? available : 0
}

/**
 * Hold a new run's whole cap against the tenant. `grantMicrousd` is an explicit,
 * single-run allowance a human approved over the tenant limit (never reusable).
 */
export function planRunCreation(
  tenant: TenantBudgetState,
  input: { capMicrousd: Microusd; maxModelCalls: number; grantMicrousd?: Microusd }
): Plan<{ run: RunBudgetState; tenant: TenantBudgetState }> {
  assertAmount(input.capMicrousd, "capMicrousd")
  const grant = input.grantMicrousd ?? 0
  assertAmount(grant, "grantMicrousd")
  const available = tenantAvailableMicrousd(tenant)
  if (available !== null && input.capMicrousd > available + grant) {
    return refuse("TENANT_BUDGET_EXHAUSTED", input.capMicrousd, available)
  }
  return {
    ok: true,
    run: {
      capMicrousd: input.capMicrousd,
      spentMicrousd: 0,
      activeReservationsMicrousd: 0,
      tenantHoldMicrousd: input.capMicrousd,
      overspendMicrousd: 0,
      frozen: false,
      modelCalls: 0,
      maxModelCalls: input.maxModelCalls,
      terminal: false,
    },
    tenant: { ...tenant, activeHoldsMicrousd: tenant.activeHoldsMicrousd + input.capMicrousd },
  }
}

// ── run level ───────────────────────────────────────────────────────────────

function admissionRefusal(state: RunBudgetState): BudgetRefusal | null {
  if (state.terminal) return refuse("RUN_TERMINAL")
  if (state.frozen) return refuse("BUDGET_FROZEN")
  return null
}

/** Reserve a stage (e.g. Judge + Synthesis) up front so later calls cannot starve it. */
export function planStageReservation(
  state: RunBudgetState,
  amountMicrousd: Microusd
): Plan<{ next: RunBudgetState; reservation: ReservationSnapshot }> {
  assertAmount(amountMicrousd, "amountMicrousd")
  const blocked = admissionRefusal(state)
  if (blocked) return blocked
  const available = runAvailableMicrousd(state)
  if (amountMicrousd > available) return refuse("RUN_BUDGET_EXHAUSTED", amountMicrousd, available)
  return {
    ok: true,
    next: {
      ...state,
      activeReservationsMicrousd: state.activeReservationsMicrousd + amountMicrousd,
    },
    reservation: { kind: "stage", amountMicrousd, state: "held" },
  }
}

/**
 * Reserve one transport attempt. Every attempt consumes a model-call slot,
 * checked against the hard `maxModelCalls` counter before any money moves.
 * With `fromStage`, the stage's held amount is CONVERTED into the call
 * reservation — the run is not charged a second time for the same money.
 */
export function planCallReservation(
  state: RunBudgetState,
  amountMicrousd: Microusd,
  fromStage?: ReservationSnapshot
): Plan<{ next: RunBudgetState; reservation: ReservationSnapshot; stage?: ReservationSnapshot }> {
  assertAmount(amountMicrousd, "amountMicrousd")
  const blocked = admissionRefusal(state)
  if (blocked) return blocked
  if (state.modelCalls >= state.maxModelCalls) return refuse("MAX_MODEL_CALLS")

  if (fromStage) {
    if (fromStage.kind !== "stage" || !canTransitionReservation(fromStage.state, "converted")) {
      return refuse("STAGE_NOT_HELD")
    }
    const covered = Math.min(amountMicrousd, fromStage.amountMicrousd)
    const extra = amountMicrousd - covered
    const available = runAvailableMicrousd(state)
    if (extra > available) return refuse("RUN_BUDGET_EXHAUSTED", extra, available)
    const stageLeft = fromStage.amountMicrousd - covered
    return {
      ok: true,
      next: {
        ...state,
        activeReservationsMicrousd: state.activeReservationsMicrousd + extra,
        modelCalls: state.modelCalls + 1,
      },
      reservation: { kind: "call", amountMicrousd, state: "held" },
      stage:
        stageLeft > 0
          ? { ...fromStage, amountMicrousd: stageLeft }
          : { ...fromStage, amountMicrousd: 0, state: "converted" },
    }
  }

  const available = runAvailableMicrousd(state)
  if (amountMicrousd > available) return refuse("RUN_BUDGET_EXHAUSTED", amountMicrousd, available)
  return {
    ok: true,
    next: {
      ...state,
      activeReservationsMicrousd: state.activeReservationsMicrousd + amountMicrousd,
      modelCalls: state.modelCalls + 1,
    },
    reservation: { kind: "call", amountMicrousd, state: "held" },
  }
}

/**
 * Release a held reservation that will never be charged: a PREPARED attempt
 * proved unsent (its model-call slot is returned) or an unused stage.
 * Uncertain reservations cannot be released — they wait for reconciliation.
 */
export function planReleaseReservation(
  state: RunBudgetState,
  reservation: ReservationSnapshot,
  options: { returnModelCall: boolean }
): Plan<{ next: RunBudgetState; reservation: ReservationSnapshot }> {
  if (!canTransitionReservation(reservation.state, "released"))
    return refuse("RESERVATION_NOT_ACTIVE")
  return {
    ok: true,
    next: {
      ...state,
      activeReservationsMicrousd: state.activeReservationsMicrousd - reservation.amountMicrousd,
      modelCalls:
        options.returnModelCall && reservation.kind === "call"
          ? state.modelCalls - 1
          : state.modelCalls,
    },
    reservation: { ...reservation, state: "released" },
  }
}

/** A dispatched call's outcome is unknowable: keep its amount held, never reuse it. */
export function planMarkUncertain(
  reservation: ReservationSnapshot
): Plan<{ reservation: ReservationSnapshot }> {
  if (!canTransitionReservation(reservation.state, "uncertain"))
    return refuse("RESERVATION_NOT_ACTIVE")
  return { ok: true, reservation: { ...reservation, state: "uncertain" } }
}

export interface SettlementEffect {
  next: RunBudgetState
  reservation: ReservationSnapshot
  /** Booked in full, even above the reservation. */
  actualMicrousd: Microusd
  /** `actual − reserved`; negative when the call came in under its reservation. */
  adjustmentMicrousd: number
  /** New overspend created by this settlement (0 when within the reservation). */
  overspendDeltaMicrousd: Microusd
  /** How much of the tenant hold this spend consumed. */
  tenantHoldConsumedMicrousd: Microusd
}

/**
 * Book the actual cost of a held or uncertain reservation. Actual cost above
 * the conservative reservation is recorded in full as overspend and freezes the
 * run against further calls (BUD-09). The tenant hold shrinks by at most what
 * it still holds; it is never driven negative.
 */
export function planSettle(
  state: RunBudgetState,
  reservation: ReservationSnapshot,
  actualMicrousd: Microusd
): Plan<SettlementEffect> {
  assertAmount(actualMicrousd, "actualMicrousd")
  if (!canTransitionReservation(reservation.state, "settled"))
    return refuse("RESERVATION_NOT_ACTIVE")
  const overspendDelta =
    actualMicrousd > reservation.amountMicrousd ? actualMicrousd - reservation.amountMicrousd : 0
  const tenantHoldConsumed = Math.min(actualMicrousd, state.tenantHoldMicrousd)
  return {
    ok: true,
    next: {
      ...state,
      spentMicrousd: state.spentMicrousd + actualMicrousd,
      activeReservationsMicrousd: state.activeReservationsMicrousd - reservation.amountMicrousd,
      tenantHoldMicrousd: state.tenantHoldMicrousd - tenantHoldConsumed,
      overspendMicrousd: state.overspendMicrousd + overspendDelta,
      frozen: state.frozen || overspendDelta > 0,
    },
    reservation: { ...reservation, state: "settled" },
    actualMicrousd,
    adjustmentMicrousd: actualMicrousd - reservation.amountMicrousd,
    overspendDeltaMicrousd: overspendDelta,
    tenantHoldConsumedMicrousd: tenantHoldConsumed,
  }
}

/**
 * Terminal release: whatever the tenant hold still covers beyond the amounts
 * pinned by uncertain reservations goes back to the tenant. Uncertain money
 * stays held until reconciliation — another run must not spend it.
 */
export function planTerminalRelease(
  state: RunBudgetState,
  uncertainMicrousd: Microusd
): { next: RunBudgetState; releasedMicrousd: Microusd } {
  assertAmount(uncertainMicrousd, "uncertainMicrousd")
  const keep = Math.min(state.tenantHoldMicrousd, uncertainMicrousd)
  return {
    next: { ...state, terminal: true, tenantHoldMicrousd: keep },
    releasedMicrousd: state.tenantHoldMicrousd - keep,
  }
}

/**
 * The tenant's active holds are the sum of per-run tenant holds, each consumed
 * or released at most once (every effect has a dedupe key), so the sum cannot
 * go below zero by construction. The floor only keeps a damaged account row
 * from turning into budget that was never held. Spend itself is never floored.
 */
function holdsAfter(activeHoldsMicrousd: Microusd, releasedMicrousd: Microusd): Microusd {
  assertAmount(releasedMicrousd, "releasedMicrousd")
  return Math.max(0, activeHoldsMicrousd - releasedMicrousd)
}

export function applyTenantSpend(
  tenant: TenantBudgetState,
  effect: { actualMicrousd: Microusd; tenantHoldConsumedMicrousd: Microusd }
): TenantBudgetState {
  return {
    limitRemainingMicrousd:
      tenant.limitRemainingMicrousd === null
        ? null
        : tenant.limitRemainingMicrousd - effect.actualMicrousd,
    activeHoldsMicrousd: holdsAfter(tenant.activeHoldsMicrousd, effect.tenantHoldConsumedMicrousd),
  }
}

export function applyTenantRelease(
  tenant: TenantBudgetState,
  releasedMicrousd: Microusd
): TenantBudgetState {
  return {
    ...tenant,
    activeHoldsMicrousd: holdsAfter(tenant.activeHoldsMicrousd, releasedMicrousd),
  }
}
