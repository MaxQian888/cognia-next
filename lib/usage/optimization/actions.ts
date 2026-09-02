// The reversible half of the optimization loop (ADR-0165 Phase 4).
//
// A finding says something is wrong. An action changes something and then
// checks whether it helped. The state machine below exists because both halves
// of that can fail in ways that must not be silent:
//
//   * An apply can lose a race. Cognia settings are changed by a dozen other
//     surfaces, so an action carries the value it EXPECTED to replace and the
//     write is a compare-and-swap. A stale action fails rather than clobbering
//     a choice the user made in the meantime.
//   * A measurement can be inconclusive. Three days and twenty comparable
//     turns is the floor, and below it the outcome is `inconclusive`, never
//     `no-effect`. Declaring no effect from four turns is how a good change
//     gets reverted.
//   * A revert can be unsafe. Auto-revert only ever touches a Cognia setting
//     whose value still hashes to what this action wrote, so a user who
//     changed it themselves afterwards keeps their change.
//
// Repository files are NOT applied from here. They go through the Task
// Workspace preview/apply/undo ledger, which already owns diff review and
// rollback, and the action record just points at that run.

import type { SessionUsageRow } from "@/lib/db/session-usage"

import { effectiveCostUsdDetailed, type PricingResolver } from "../session-analytics"
import { resolveModelPricingUsd } from "../pricing"
import type { OptimizationFindingV1 } from "./findings"

export const ACTION_SCHEMA_VERSION = 1

/** Lifecycle of one attempted optimization. */
export type ActionState =
  /** Proposed, nothing changed yet. */
  | "previewed"
  /** The change landed. */
  | "applied"
  /** Applied, and the follow-up window has not closed. */
  | "measuring"
  /** Measured: it helped. */
  | "worked"
  /** Measured: it helped less than claimed. */
  | "partial"
  /** Measured: no detectable change. */
  | "no-effect"
  /** Not enough comparable evidence to say either way. */
  | "inconclusive"
  /** Rolled back, by the user or by auto-revert. */
  | "reverted"
  /** The apply itself failed. */
  | "failed"

/** Transitions the machine allows. Anything else is a bug in a caller. */
const ALLOWED: Record<ActionState, readonly ActionState[]> = {
  previewed: ["applied", "failed"],
  applied: ["measuring", "reverted", "failed"],
  measuring: ["worked", "partial", "no-effect", "inconclusive", "reverted"],
  worked: ["reverted"],
  partial: ["reverted"],
  "no-effect": ["reverted"],
  inconclusive: ["measuring", "reverted"],
  reverted: [],
  failed: ["previewed"],
}

export function canTransition(from: ActionState, to: ActionState): boolean {
  return ALLOWED[from].includes(to)
}

export interface OptimizationActionRecord {
  schemaVersion: typeof ACTION_SCHEMA_VERSION
  /** Primary key. Stable across the action's whole life. */
  id: string
  findingId: string
  detector: OptimizationFindingV1["detector"]
  detectorVersion: number
  state: ActionState
  target: NonNullable<OptimizationFindingV1["action"]>["target"]
  key: string
  /** Serialized value the action expected to replace, for the CAS check. */
  expectedValue?: string
  /** Serialized value the action wrote. */
  appliedValue?: string
  /** Hash of `appliedValue`, so auto-revert can tell "still mine" from "changed". */
  appliedHash?: string
  /** Task Workspace run backing a repo-file change, when the target is one. */
  taskWorkspaceRunId?: string
  createdAt: number
  appliedAt?: number
  /** When the measurement window opened. */
  measuringFrom?: number
  resolvedAt?: number
  /** Baseline the follow-up is compared against. */
  baseline?: MeasurementSample
  followUp?: MeasurementSample
  /** Coarse, non-identifying failure reason. Never an OS message. */
  failureReason?: "stale" | "unsupported" | "write-failed" | "not-permitted"
}

/** A comparable slice of spend, used on both sides of a measurement. */
export interface MeasurementSample {
  fromMs: number
  toMs: number
  turns: number
  knownCostUsd: number
  /** Mean cost of a priced turn. The figure the comparison actually uses. */
  costPerTurnUsd: number | null
}

/** Minimum evidence before an outcome is anything but `inconclusive`. */
export const MIN_MEASUREMENT_DAYS = 3
export const MIN_MEASUREMENT_TURNS = 20

const DAY_MS = 86_400_000

/** Summarize a window into a comparable sample. */
export function sampleWindow(
  rows: readonly SessionUsageRow[],
  fromMs: number,
  toMs: number,
  resolve: PricingResolver = resolveModelPricingUsd
): MeasurementSample {
  let knownCostUsd = 0
  let priced = 0
  let turns = 0
  for (const row of rows) {
    if (row.at < fromMs || row.at > toMs) continue
    turns += 1
    const cost = effectiveCostUsdDetailed(row, resolve)
    if (cost.known) {
      knownCostUsd += cost.cost
      priced += 1
    }
  }
  return {
    fromMs,
    toMs,
    turns,
    knownCostUsd,
    // Per-turn, not total: a week where the user simply worked less would
    // otherwise read as a saving the change did not produce.
    costPerTurnUsd: priced > 0 ? knownCostUsd / priced : null,
  }
}

/** How much better (positive) or worse (negative) the follow-up was, 0-1 scale. */
export function measuredDelta(
  baseline: MeasurementSample,
  followUp: MeasurementSample
): number | null {
  if (baseline.costPerTurnUsd == null || followUp.costPerTurnUsd == null) return null
  if (baseline.costPerTurnUsd <= 0) return null
  return (baseline.costPerTurnUsd - followUp.costPerTurnUsd) / baseline.costPerTurnUsd
}

/** Whether a follow-up window carries enough evidence to judge at all. */
export function measurementIsSufficient(sample: MeasurementSample): boolean {
  const days = (sample.toMs - sample.fromMs) / DAY_MS
  return days >= MIN_MEASUREMENT_DAYS && sample.turns >= MIN_MEASUREMENT_TURNS
}

/**
 * Grade an applied action.
 *
 * `inconclusive` on thin evidence is not a hedge, it is the correct answer:
 * the alternative is telling someone a change did nothing on the strength of
 * four turns, and watching them revert something that worked.
 */
export function gradeOutcome(
  finding: Pick<OptimizationFindingV1, "estimatedSavingUsd" | "impactUsd">,
  baseline: MeasurementSample,
  followUp: MeasurementSample
): Extract<ActionState, "worked" | "partial" | "no-effect" | "inconclusive"> {
  if (!measurementIsSufficient(followUp) || !measurementIsSufficient(baseline)) {
    return "inconclusive"
  }
  const delta = measuredDelta(baseline, followUp)
  if (delta == null) return "inconclusive"
  const claimed =
    finding.impactUsd > 0 ? Math.min(1, finding.estimatedSavingUsd / finding.impactUsd) : 0
  if (delta <= 0.02) return "no-effect"
  // Two thirds of what was claimed is close enough to call it a win. Demanding
  // the full figure would grade an honest, conservative estimate as a failure.
  if (claimed > 0 && delta >= claimed * 0.66) return "worked"
  return delta >= 0.05 ? "partial" : "no-effect"
}

/** Stable, order-independent hash of a serialized value. Not cryptographic. */
export function hashValue(value: string): string {
  let h = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

export type CasResult =
  | { ok: true; appliedValue: string; appliedHash: string }
  | { ok: false; reason: NonNullable<OptimizationActionRecord["failureReason"]> }

/**
 * Compare-and-swap a Cognia-owned setting.
 *
 * `read` and `write` are injected so this stays pure and testable and so the
 * settings store is not a dependency of the optimizer. A mismatch between the
 * current value and `expectedValue` fails as `stale`: somebody changed it
 * between the preview and the apply, and their choice outranks ours.
 */
export async function applyWithCas(args: {
  key: string
  expectedValue: string
  proposedValue: string
  read: (key: string) => Promise<string | null>
  write: (key: string, value: string) => Promise<void>
}): Promise<CasResult> {
  let current: string | null
  try {
    current = await args.read(args.key)
  } catch {
    return { ok: false, reason: "write-failed" }
  }
  if ((current ?? "") !== args.expectedValue) return { ok: false, reason: "stale" }
  try {
    await args.write(args.key, args.proposedValue)
  } catch {
    return { ok: false, reason: "write-failed" }
  }
  return { ok: true, appliedValue: args.proposedValue, appliedHash: hashValue(args.proposedValue) }
}

/**
 * Whether auto-revert may touch this action.
 *
 * Three conditions, all required. Only a Cognia-owned setting, because a repo
 * file belongs to the Task Workspace ledger and to the user's git history.
 * Only when the current value still hashes to what we wrote, so a user who
 * adjusted it afterwards keeps their adjustment. And only when the user opted
 * in, because silently undoing a change nobody remembers making is worse than
 * leaving a mediocre setting in place.
 */
export function canAutoRevert(args: {
  record: Pick<OptimizationActionRecord, "target" | "appliedHash">
  currentValue: string | null
  optedIn: boolean
}): boolean {
  if (!args.optedIn) return false
  if (args.record.target !== "cognia-setting") return false
  if (!args.record.appliedHash) return false
  if (args.currentValue == null) return false
  return hashValue(args.currentValue) === args.record.appliedHash
}

/** Build the record a preview creates. Nothing is written yet. */
export function previewAction(args: {
  finding: OptimizationFindingV1
  expectedValue?: string
  now?: number
}): OptimizationActionRecord | null {
  const action = args.finding.action
  if (!action) return null
  return {
    schemaVersion: ACTION_SCHEMA_VERSION,
    id: `${args.finding.id}:${args.now ?? Date.now()}`,
    findingId: args.finding.id,
    detector: args.finding.detector,
    detectorVersion: args.finding.detectorVersion,
    state: "previewed",
    target: action.target,
    key: action.key,
    ...(args.expectedValue !== undefined ? { expectedValue: args.expectedValue } : {}),
    createdAt: args.now ?? Date.now(),
  }
}

/**
 * Move a record to a new state, refusing an illegal transition.
 *
 * Returns `null` rather than throwing, so a stale UI clicking "apply" twice is
 * a no-op instead of an error dialog about a state machine.
 */
export function transition(
  record: OptimizationActionRecord,
  to: ActionState,
  patch: Partial<OptimizationActionRecord> = {}
): OptimizationActionRecord | null {
  if (!canTransition(record.state, to)) return null
  return { ...record, ...patch, state: to }
}
