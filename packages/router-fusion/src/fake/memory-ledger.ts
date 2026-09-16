/**
 * In-memory CallLedgerPort built on the pure planner — the reference behaviour
 * the host's Dexie ledger store must match, and the ledger the offline Fake
 * Provider end-to-end tests run against. Not persistent; never used by a host
 * outside tests and the explicitly-labelled mock mode.
 */

import type { RateCard } from "../contracts/schemas"
import type { FusionDeployment } from "../config/types"
import {
  planCallReservation,
  planMarkUncertain,
  planReleaseReservation,
  planRunCreation,
  planSettle,
  planStageReservation,
  type ReservationSnapshot,
  type RunBudgetState,
} from "../ledger/planner"
import type { CallAttemptState } from "../state/call-attempt"
import { normalizeUsage, priceUsage } from "../usage/normalize"
import type {
  CallLedgerPort,
  CommittedCallResult,
  PrepareCallInput,
  PrepareOutcome,
  SettleCallInput,
  SettleOutcome,
} from "../workflows/ports"

export interface MemoryAttempt {
  attemptId: string
  logicalStepId: string
  attemptNo: number
  role: string
  deploymentId: string
  state: CallAttemptState
  reservation: ReservationSnapshot
  requestHash: string
  result?: CommittedCallResult
  actualMicrousd?: number
  providerRequestId?: string | null
}

export interface LedgerRow {
  kind: "hold" | "settle" | "overspend" | "release" | "stage" | "abandon" | "unknown"
  attemptId?: string
  amountMicrousd: number
  dedupeKey: string
}

export interface MemoryLedgerOptions {
  capMicrousd: number
  maxModelCalls: number
  deployments: Record<string, FusionDeployment>
  rateCards: Record<string, RateCard>
  unknownPriceActualMicrousd?: number
  /** Consulted on every prepare: false models a run that stopped running or was revoked. */
  admit?: () => PrepareOutcome | null
}

export class MemoryCallLedger implements CallLedgerPort {
  state: RunBudgetState
  readonly attempts: MemoryAttempt[] = []
  readonly rows: LedgerRow[] = []
  readonly stages = new Map<string, ReservationSnapshot>()
  private seq = 0

  constructor(private readonly options: MemoryLedgerOptions) {
    const created = planRunCreation(
      { limitRemainingMicrousd: null, activeHoldsMicrousd: 0 },
      { capMicrousd: options.capMicrousd, maxModelCalls: options.maxModelCalls }
    )
    if (!created.ok) throw new Error(created.code)
    this.state = created.run
  }

  private addRow(row: LedgerRow): boolean {
    if (this.rows.some((existing) => existing.dedupeKey === row.dedupeKey)) return false
    this.rows.push(row)
    return true
  }

  async prepare(input: PrepareCallInput): Promise<PrepareOutcome> {
    const committed = this.attempts.find(
      (a) => a.logicalStepId === input.logicalStepId && a.state === "SUCCEEDED"
    )
    if (committed?.result) return { kind: "replay", result: committed.result }
    const unanswered = this.attempts.some(
      (a) =>
        a.logicalStepId === input.logicalStepId &&
        (a.state === "UNKNOWN" || a.state === "RECONCILED")
    )
    if (unanswered) return { kind: "refused", code: "STEP_OUTCOME_UNKNOWN" }
    const admission = this.options.admit?.()
    if (admission) return admission

    const stage = input.fromStageId ? this.stages.get(input.fromStageId) : undefined
    const plan = planCallReservation(this.state, input.reserveMicrousd, stage)
    if (!plan.ok) return { kind: "refused", code: plan.code }
    this.state = plan.next
    if (input.fromStageId && plan.stage) this.stages.set(input.fromStageId, plan.stage)

    const attemptNo =
      this.attempts.filter((a) => a.logicalStepId === input.logicalStepId).length + 1
    const attemptId = `attempt-${++this.seq}`
    this.attempts.push({
      attemptId,
      logicalStepId: input.logicalStepId,
      attemptNo,
      role: input.role,
      deploymentId: input.deploymentId,
      state: "PREPARED",
      reservation: plan.reservation,
      requestHash: input.requestHash,
    })
    this.addRow({
      kind: "hold",
      attemptId,
      amountMicrousd: input.reserveMicrousd,
      dedupeKey: `hold:${attemptId}`,
    })
    return { kind: "granted", attemptId, attemptNo }
  }

  private attempt(attemptId: string): MemoryAttempt {
    const found = this.attempts.find((a) => a.attemptId === attemptId)
    if (!found) throw new Error(`unknown attempt ${attemptId}`)
    return found
  }

  async markDispatched(attemptId: string): Promise<void> {
    const attempt = this.attempt(attemptId)
    if (attempt.state !== "PREPARED") throw new Error(`cannot dispatch ${attempt.state}`)
    attempt.state = "DISPATCHED"
  }

  private priceOf(
    attempt: MemoryAttempt,
    input: SettleCallInput
  ): { amount: number; status: SettleOutcome["costStatus"] } {
    if (!input.usage || !input.semantics) {
      // An explicit failure without a bill produced nothing billable; a call
      // that succeeded or was UNKNOWN is booked at its reservation, never zero.
      return input.status === "failed" && attempt.state !== "UNKNOWN"
        ? { amount: 0, status: "actual" }
        : { amount: attempt.reservation.amountMicrousd, status: "estimated" }
    }
    const deployment = this.options.deployments[attempt.deploymentId]
    const card = deployment?.rateCardId ? this.options.rateCards[deployment.rateCardId] : undefined
    if (!card)
      return {
        amount: this.options.unknownPriceActualMicrousd ?? attempt.reservation.amountMicrousd,
        status: "estimated",
      }
    return {
      amount: priceUsage(normalizeUsage(input.usage, input.semantics), card).total_microusd,
      status: "actual",
    }
  }

  async settle(attemptId: string, input: SettleCallInput): Promise<SettleOutcome> {
    const attempt = this.attempt(attemptId)
    const { amount, status } = this.priceOf(attempt, input)
    if (
      !this.addRow({
        kind: "settle",
        attemptId,
        amountMicrousd: amount,
        dedupeKey: `settle:${attemptId}`,
      })
    ) {
      return {
        actualMicrousd: attempt.actualMicrousd ?? 0,
        frozen: this.state.frozen,
        costStatus: status,
      }
    }
    const plan = planSettle(this.state, attempt.reservation, amount)
    if (!plan.ok) throw new Error(plan.code)
    this.state = plan.next
    attempt.reservation = plan.reservation
    attempt.actualMicrousd = amount
    attempt.providerRequestId = input.providerRequestId
    if (plan.overspendDeltaMicrousd > 0) {
      this.addRow({
        kind: "overspend",
        attemptId,
        amountMicrousd: plan.overspendDeltaMicrousd,
        dedupeKey: `overspend:${attemptId}`,
      })
    }
    if (attempt.state === "UNKNOWN") attempt.state = "RECONCILED"
    else attempt.state = input.status === "succeeded" ? "SUCCEEDED" : "FAILED"
    if (input.result) attempt.result = input.result
    return { actualMicrousd: amount, frozen: this.state.frozen, costStatus: status }
  }

  async markUnknown(attemptId: string): Promise<void> {
    const attempt = this.attempt(attemptId)
    if (attempt.state !== "DISPATCHED") throw new Error(`cannot mark ${attempt.state} unknown`)
    const plan = planMarkUncertain(attempt.reservation)
    if (!plan.ok) throw new Error(plan.code)
    attempt.reservation = plan.reservation
    attempt.state = "UNKNOWN"
    this.addRow({
      kind: "unknown",
      attemptId,
      amountMicrousd: attempt.reservation.amountMicrousd,
      dedupeKey: `unknown:${attemptId}`,
    })
  }

  /** Recovery path: a PREPARED attempt proved never sent gives back its money and its slot. */
  async abandon(attemptId: string): Promise<void> {
    const attempt = this.attempt(attemptId)
    if (attempt.state !== "PREPARED") throw new Error(`cannot abandon ${attempt.state}`)
    const plan = planReleaseReservation(this.state, attempt.reservation, { returnModelCall: true })
    if (!plan.ok) throw new Error(plan.code)
    this.state = plan.next
    attempt.reservation = plan.reservation
    attempt.state = "ABANDONED"
    this.addRow({
      kind: "abandon",
      attemptId,
      amountMicrousd: 0,
      dedupeKey: `abandon:${attemptId}`,
    })
  }

  async reserveStage(stageId: string, amountMicrousd: number) {
    // Idempotent per stage, like the host store: a replayed graph re-asks for
    // the stage it already holds (or already spent) and is not charged twice.
    if (this.stages.has(stageId)) return { kind: "granted" as const }
    const plan = planStageReservation(this.state, amountMicrousd)
    if (!plan.ok) return { kind: "refused" as const, code: plan.code }
    this.state = plan.next
    this.stages.set(stageId, plan.reservation)
    this.addRow({ kind: "stage", amountMicrousd, dedupeKey: `stage:${stageId}` })
    return { kind: "granted" as const }
  }

  async releaseStage(stageId: string): Promise<void> {
    const stage = this.stages.get(stageId)
    if (!stage || stage.state !== "held") return
    const plan = planReleaseReservation(this.state, stage, { returnModelCall: false })
    if (!plan.ok) return
    this.state = plan.next
    this.stages.set(stageId, plan.reservation)
  }

  totalSettledMicrousd(): number {
    return this.rows
      .filter((r) => r.kind === "settle")
      .reduce((sum, r) => sum + r.amountMicrousd, 0)
  }
}
