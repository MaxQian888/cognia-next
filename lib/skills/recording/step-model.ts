/**
 * The review timeline's data model: a captured step plus the user's edits to it.
 *
 * Edits are stored **separately from the capture** and replayed over it
 * ([`applyStepEdits`]). That is what makes a recorded source version immutable:
 * re-opening a saved recording reproduces the same review state without ever
 * having rewritten what was captured, and "duplicate as a new editable version"
 * is just a second edit set over the same bundle.
 *
 * Everything here is pure, so the whole include/exclude/reorder/annotate surface
 * is testable without a DOM.
 */

import type { RecordedStep } from "./types"
import { stepIsSemanticallyEmpty } from "./types"

/** A user-authored step, inserted between captured ones. */
export interface ManualStep {
  /** Negative so it can never collide with a native `seq` (which starts at 1). */
  seq: number
  intent: string
  /** Ordering key: sits immediately after the captured step with this seq. */
  afterSeq: number
}

export interface StepEdit {
  excluded?: boolean
  /** Replaces the derived description entirely. */
  intent?: string
  /** A condition the agent should check after performing this step. */
  verify?: string
  /** Whether this step's frame is attached to the saved skill. */
  screenshotSelected?: boolean
}

export interface StepEdits {
  /** Keyed by `seq`. Absent means "no edits". */
  bySeq: Record<number, StepEdit>
  /** Explicit display order by `seq`. Absent means capture order. */
  order?: number[]
  manual: ManualStep[]
}

export const EMPTY_STEP_EDITS: StepEdits = { bySeq: {}, manual: [] }

/** A captured or manual step, with its edits already applied. */
export interface RecordedStepView {
  seq: number
  /** Manual steps have no capture behind them. */
  captured: RecordedStep | null
  manual: boolean
  excluded: boolean
  intent: string | null
  verify: string | null
  screenshotSelected: boolean
  /** True when nothing here could describe the step to a model. */
  needsIntent: boolean
}

/**
 * Next free manual `seq`.
 *
 * Manual steps count down from -1 so they occupy a disjoint space from native
 * seqs. Sharing the space would make an edit keyed by `seq` ambiguous the moment
 * a recording is resumed and the native counter advances past it.
 */
export function nextManualSeq(edits: StepEdits): number {
  const lowest = edits.manual.reduce((min, step) => Math.min(min, step.seq), 0)
  return lowest - 1
}

function defaultScreenshotSelected(step: RecordedStep): boolean {
  return Boolean(step.assetId)
}

/**
 * Materialize the review timeline.
 *
 * Out-of-scope markers are dropped: they exist so the *count* of ignored actions
 * is honest, but they carry nothing to review and putting them in the list would
 * imply there is something to look at.
 */
export function applyStepEdits(
  captured: readonly RecordedStep[],
  edits: StepEdits = EMPTY_STEP_EDITS
): RecordedStepView[] {
  const views: RecordedStepView[] = captured
    .filter((step) => step.kind !== "outOfScope")
    .map((step) => {
      const edit = edits.bySeq[step.seq] ?? {}
      return {
        seq: step.seq,
        captured: step,
        manual: false,
        excluded: edit.excluded ?? false,
        intent: edit.intent ?? null,
        verify: edit.verify ?? null,
        screenshotSelected: edit.screenshotSelected ?? defaultScreenshotSelected(step),
        needsIntent: stepIsSemanticallyEmpty(step) && !edit.intent,
      }
    })

  for (const manual of edits.manual) {
    const edit = edits.bySeq[manual.seq] ?? {}
    const view: RecordedStepView = {
      seq: manual.seq,
      captured: null,
      manual: true,
      excluded: edit.excluded ?? false,
      intent: edit.intent ?? manual.intent,
      verify: edit.verify ?? null,
      screenshotSelected: false,
      needsIntent: (edit.intent ?? manual.intent).trim().length === 0,
    }
    const anchor = views.findIndex((v) => v.seq === manual.afterSeq)
    if (anchor === -1) views.push(view)
    else views.splice(anchor + 1, 0, view)
  }

  if (!edits.order?.length) return views

  // An explicit order wins, but a seq the order does not mention still appears —
  // dropping steps because a stale order forgot them would silently lose work.
  const bySeq = new Map(views.map((v) => [v.seq, v]))
  const ordered: RecordedStepView[] = []
  for (const seq of edits.order) {
    const view = bySeq.get(seq)
    if (view) {
      ordered.push(view)
      bySeq.delete(seq)
    }
  }
  return [...ordered, ...bySeq.values()]
}

export function setStepEdit(edits: StepEdits, seq: number, patch: StepEdit): StepEdits {
  return {
    ...edits,
    bySeq: { ...edits.bySeq, [seq]: { ...edits.bySeq[seq], ...patch } },
  }
}

export function excludeStep(edits: StepEdits, seq: number): StepEdits {
  return setStepEdit(edits, seq, { excluded: true })
}

/**
 * Undo an exclusion.
 *
 * Only the `excluded` flag is cleared — a restored step keeps the intent and
 * verification the user wrote before excluding it, which is the whole reason
 * exclusion is a flag rather than a deletion.
 */
export function restoreStep(edits: StepEdits, seq: number): StepEdits {
  return setStepEdit(edits, seq, { excluded: false })
}

export function insertManualStep(edits: StepEdits, afterSeq: number, intent: string): StepEdits {
  return {
    ...edits,
    manual: [...edits.manual, { seq: nextManualSeq(edits), afterSeq, intent }],
  }
}

export function removeManualStep(edits: StepEdits, seq: number): StepEdits {
  const { [seq]: _dropped, ...rest } = edits.bySeq
  return {
    ...edits,
    bySeq: rest,
    manual: edits.manual.filter((step) => step.seq !== seq),
  }
}

/** Move one step by `delta` places, clamped to the ends. */
export function reorderSteps(
  views: readonly RecordedStepView[],
  edits: StepEdits,
  seq: number,
  delta: number
): StepEdits {
  const order = views.map((v) => v.seq)
  const from = order.indexOf(seq)
  if (from === -1) return edits
  const to = Math.min(Math.max(from + delta, 0), order.length - 1)
  if (to === from) return edits
  const next = [...order]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return { ...edits, order: next }
}

export function includedSteps(views: readonly RecordedStepView[]): RecordedStepView[] {
  return views.filter((view) => !view.excluded)
}

export function selectedScreenshotIds(views: readonly RecordedStepView[]): string[] {
  return includedSteps(views)
    .filter((view) => view.screenshotSelected && view.captured?.assetId)
    .map((view) => view.captured!.assetId!)
}

/** Why generation is not yet allowed. Empty means the timeline is ready. */
export type ReviewBlocker =
  | { code: "noIncludedSteps" }
  | { code: "stepNeedsIntent"; seq: number }
  | { code: "unconfirmedVariable"; name: string }
  | { code: "sensitiveVariableHasValue"; name: string }

/**
 * Validate the timeline before anything can leave the device.
 *
 * Deliberately blocking rather than advisory: a step with no semantics produces
 * a skill instruction like "click at (412, 908)", which is worse than useless —
 * it looks authoritative and is unrepeatable.
 */
export function reviewBlockers(
  views: readonly RecordedStepView[],
  variables: readonly { name: string; confirmed: boolean; kind: string; sample?: string }[]
): ReviewBlocker[] {
  const blockers: ReviewBlocker[] = []
  const included = includedSteps(views)
  if (included.length === 0) blockers.push({ code: "noIncludedSteps" })
  for (const view of included) {
    if (view.needsIntent) blockers.push({ code: "stepNeedsIntent", seq: view.seq })
  }
  for (const variable of variables) {
    if (!variable.confirmed) {
      blockers.push({ code: "unconfirmedVariable", name: variable.name })
    }
    if (variable.kind === "sensitive" && variable.sample) {
      blockers.push({ code: "sensitiveVariableHasValue", name: variable.name })
    }
  }
  return blockers
}
