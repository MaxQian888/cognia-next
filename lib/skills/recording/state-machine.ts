/**
 * The recorder's one authoritative state machine.
 *
 * Pure: no React, no Dexie, no native calls. That is what lets every legal and
 * illegal transition be asserted directly instead of inferred from UI behaviour.
 *
 * Three design choices worth keeping:
 *
 * - **Transitions are a table, not a `switch`.** "A retriable error returns to
 *   the last recoverable phase" becomes a data property (`recoveryPhaseFor`)
 *   rather than a rule re-derived at each call site.
 * - **The single-live-session invariant lives here.** `OPEN` from a non-idle
 *   phase only raises the Sheet; it never starts a second recording. That *is*
 *   "reattach instead of duplicate", and enforcing it in the reducer means the
 *   four entry points cannot each get it subtly wrong.
 * - **An illegal transition returns `null`.** The caller decides whether that is
 *   a no-op or a bug; the reducer never silently invents a state.
 */

import type {
  CaptureScope,
  InterruptReason,
  RecordLimits,
  RecordedStep,
  RecordingId,
  LimitUsage,
} from "./types"
import type { InputVariable } from "./input-variables"
import type { RecordedStepView, StepEdits } from "./step-model"

export type RecorderPhase =
  | "idle"
  | "setup"
  | "preflight"
  | "recording"
  | "paused"
  | "stopping"
  | "review"
  | "generating"
  | "draft"
  | "saving"
  | "saved"
  | "interrupted"

/** The five stages the Sheet chrome shows. Several phases map to one stage. */
export type RecorderStage = "setup" | "recording" | "review" | "generate" | "save"

export const STAGES: readonly RecorderStage[] = [
  "setup",
  "recording",
  "review",
  "generate",
  "save",
] as const

export function stageForPhase(phase: RecorderPhase): RecorderStage {
  switch (phase) {
    case "idle":
    case "setup":
    case "preflight":
      return "setup"
    case "recording":
    case "paused":
    case "stopping":
      return "recording"
    case "review":
      return "review"
    case "generating":
    case "draft":
      return "generate"
    case "saving":
    case "saved":
      return "save"
    case "interrupted":
      // An interrupt is shown in place, over whichever stage the user was on;
      // the banner carries the recovery action.
      return "review"
  }
}

export type RecorderEntrySource =
  | "toolbar"
  | "palette"
  | "slash-command"
  | "shortcut"
  | "plugin-command"
  | "recovery"
  | "session-suggestion"

export interface RecorderError {
  /** Stable code; the renderer maps it to localized copy. */
  code: string
  detail?: string
  retriable: boolean
}

export interface RecorderInterrupt {
  reason: InterruptReason
  from: RecorderPhase
  retriable: boolean
}

/**
 * A recording the user cannot resume by retrying. Permission loss needs a
 * settings trip; a kill switch is an explicit "stop" that we must not undo on
 * their behalf.
 */
const NON_RETRIABLE_INTERRUPTS: readonly InterruptReason[] = ["permissionLost", "killSwitch"]

export function interruptIsRetriable(reason: InterruptReason): boolean {
  return !NON_RETRIABLE_INTERRUPTS.includes(reason)
}

export interface GeneratedDraft {
  name: string
  description: string
  content: string
  tags: string[]
  category: string
  allowedTools: string[]
}

export interface GenerationProvenance {
  provider: string
  model: string
  locale: string
  redacted: boolean
  generatedAt: number
  /** Stable hash of the exact outbound payload, so a draft can be tied to it. */
  promptHash: string
}

export interface RecorderSnapshot {
  phase: RecorderPhase
  recordingId: RecordingId | null
  bundleId: RecordingId | null
  startedAt: number | null
  scope: CaptureScope | null
  limits: RecordLimits | null
  usage: LimitUsage[]
  steps: RecordedStepView[]
  ignoredCount: number
  inputVariables: InputVariable[]
  draft: GeneratedDraft | null
  /** A regeneration result awaiting merge. Never overwrites `draft`. */
  candidateDraft: GeneratedDraft | null
  generation: GenerationProvenance | null
  draftStale: boolean
  manualEdits: boolean
  savedSkillId: string | null
  trialSessionId: string | null
  trialConfirmed: boolean
  error: RecorderError | null
  interrupt: RecorderInterrupt | null
}

export const INITIAL_SNAPSHOT: RecorderSnapshot = {
  phase: "idle",
  recordingId: null,
  bundleId: null,
  startedAt: null,
  scope: null,
  limits: null,
  usage: [],
  steps: [],
  ignoredCount: 0,
  inputVariables: [],
  draft: null,
  candidateDraft: null,
  generation: null,
  draftStale: false,
  manualEdits: false,
  savedSkillId: null,
  trialSessionId: null,
  trialConfirmed: false,
  error: null,
  interrupt: null,
}

export type RecorderEvent =
  | { type: "OPEN"; source: RecorderEntrySource }
  | { type: "PREFLIGHT_START" }
  | { type: "PREFLIGHT_OK" }
  | { type: "PREFLIGHT_FAIL"; error: RecorderError }
  | {
      type: "NATIVE_STARTED"
      recordingId: RecordingId
      startedAt: number
      scope: CaptureScope
      limits: RecordLimits
    }
  | { type: "STEP"; step: RecordedStep }
  | { type: "USAGE"; usage: LimitUsage[] }
  | { type: "PAUSE" }
  | { type: "RESUME" }
  | { type: "UNDONE"; seq: number }
  | { type: "STOP_REQUESTED" }
  | { type: "STOPPED"; steps: RecordedStep[]; ignoredCount: number; bundleId: RecordingId }
  | { type: "EDIT_STEPS"; edits: StepEdits }
  | { type: "SET_VARIABLES"; variables: InputVariable[] }
  | { type: "GENERATE_REQUESTED" }
  | {
      type: "GENERATED"
      draft: GeneratedDraft
      provenance: GenerationProvenance
      asCandidate: boolean
    }
  | { type: "GENERATE_FAILED"; error: RecorderError }
  | { type: "DRAFT_EDITED"; patch: Partial<GeneratedDraft> }
  | { type: "MERGE_CANDIDATE"; draft: GeneratedDraft }
  | { type: "DISCARD_CANDIDATE" }
  | { type: "SAVE_REQUESTED" }
  | { type: "SAVED"; skillId: string }
  | { type: "SAVE_FAILED"; error: RecorderError }
  | { type: "TRIAL_STARTED"; sessionId: string }
  | { type: "TRIAL_CONFIRMED" }
  | { type: "INTERRUPT"; reason: InterruptReason }
  | { type: "RETRY" }
  | { type: "REATTACH"; snapshot: RecorderSnapshot }
  | { type: "CLOSE" }

/**
 * Where `RETRY` lands after an interrupt, by the phase it happened in.
 *
 * A recording that captured something goes to review — the work is on disk and
 * throwing it away would be the wrong default. One that captured nothing goes
 * back to setup, because there is nothing to review.
 */
export function recoveryPhaseFor(from: RecorderPhase, hasSteps: boolean): RecorderPhase {
  switch (from) {
    case "recording":
    case "paused":
    case "stopping":
      return hasSteps ? "review" : "setup"
    case "generating":
      return "review"
    case "saving":
      return "draft"
    case "preflight":
    case "setup":
    case "idle":
      return "setup"
    case "review":
    case "draft":
    case "saved":
    case "interrupted":
      return from === "interrupted" ? "setup" : from
  }
}

/** Legal source phases for each event. `INTERRUPT` and `CLOSE` are universal. */
const LEGAL_FROM: Record<RecorderEvent["type"], readonly RecorderPhase[] | "any"> = {
  OPEN: "any",
  PREFLIGHT_START: ["setup"],
  PREFLIGHT_OK: ["preflight"],
  PREFLIGHT_FAIL: ["preflight"],
  NATIVE_STARTED: ["preflight"],
  STEP: ["recording"],
  USAGE: ["recording", "paused"],
  PAUSE: ["recording"],
  RESUME: ["paused"],
  UNDONE: ["recording", "paused"],
  STOP_REQUESTED: ["recording", "paused"],
  STOPPED: ["stopping", "recording", "paused"],
  EDIT_STEPS: ["review", "generating", "draft"],
  SET_VARIABLES: ["review", "draft"],
  GENERATE_REQUESTED: ["review", "draft"],
  GENERATED: ["generating"],
  GENERATE_FAILED: ["generating"],
  DRAFT_EDITED: ["draft"],
  MERGE_CANDIDATE: ["draft"],
  DISCARD_CANDIDATE: ["draft"],
  SAVE_REQUESTED: ["draft"],
  SAVED: ["saving"],
  SAVE_FAILED: ["saving"],
  TRIAL_STARTED: ["saved"],
  TRIAL_CONFIRMED: ["saved"],
  INTERRUPT: "any",
  RETRY: ["interrupted"],
  REATTACH: "any",
  CLOSE: "any",
}

function isLegal(event: RecorderEvent["type"], phase: RecorderPhase): boolean {
  const from = LEGAL_FROM[event]
  return from === "any" || from.includes(phase)
}

/**
 * Variable suggestions the user has not answered yet.
 *
 * Every suggestion arrives unconfirmed, and an unconfirmed one is not inert: the
 * envelope falls back to the raw recorded text for it, so generating now would
 * ship whatever the user typed to the model *and* hard-code it into the skill.
 * That is why this gates generation rather than merely warning.
 */
export function unconfirmedVariableCount(state: RecorderSnapshot): number {
  return state.inputVariables.filter((variable) => !variable.confirmed).length
}

/** Whether generation may be requested from the current snapshot. */
export function canGenerate(state: RecorderSnapshot): boolean {
  return isLegal("GENERATE_REQUESTED", state.phase) && unconfirmedVariableCount(state) === 0
}

/**
 * Apply one event.
 *
 * Returns `null` for an illegal transition. Callers treat that as "ignore" and,
 * in development, warn — a `null` means the UI offered an action the machine
 * does not have, which is a bug in the UI rather than in the user's input.
 */
export function reduceRecorder(
  state: RecorderSnapshot,
  event: RecorderEvent
): RecorderSnapshot | null {
  if (!isLegal(event.type, state.phase)) return null

  // The one guard that is not expressible in `LEGAL_FROM`: it depends on the
  // snapshot's contents, not on its phase. Enforced here rather than in the UI
  // so the manual-template path (`adoptManualDraft`) and the model path cannot
  // disagree about it.
  if (event.type === "GENERATE_REQUESTED" && unconfirmedVariableCount(state) > 0) return null

  switch (event.type) {
    case "OPEN":
      // The single-live-session invariant. Opening from any non-idle phase is a
      // reattach: the Sheet comes back to whatever is already in flight.
      if (state.phase !== "idle") return state
      return { ...INITIAL_SNAPSHOT, phase: "setup" }

    case "PREFLIGHT_START":
      return { ...state, phase: "preflight", error: null }

    case "PREFLIGHT_OK":
      return state

    case "PREFLIGHT_FAIL":
      return { ...state, phase: "setup", error: event.error }

    case "NATIVE_STARTED":
      return {
        ...state,
        phase: "recording",
        recordingId: event.recordingId,
        bundleId: event.recordingId,
        startedAt: event.startedAt,
        scope: event.scope,
        limits: event.limits,
        error: null,
      }

    case "STEP":
      return state

    case "USAGE":
      return { ...state, usage: event.usage }

    case "PAUSE":
      return { ...state, phase: "paused" }

    case "RESUME":
      return { ...state, phase: "recording" }

    case "UNDONE":
      return state

    case "STOP_REQUESTED":
      return { ...state, phase: "stopping" }

    case "STOPPED":
      return {
        ...state,
        phase: "review",
        bundleId: event.bundleId,
        ignoredCount: event.ignoredCount,
      }

    case "EDIT_STEPS":
      // Any timeline change after a draft exists makes that draft stale. It is
      // not discarded — the user may have hand-edited it — but the UI must stop
      // presenting it as describing what they now see.
      return { ...state, draftStale: state.draft !== null }

    case "SET_VARIABLES":
      return {
        ...state,
        inputVariables: event.variables,
        draftStale: state.draft !== null,
      }

    case "GENERATE_REQUESTED":
      return { ...state, phase: "generating", error: null }

    case "GENERATED":
      return event.asCandidate
        ? { ...state, phase: "draft", candidateDraft: event.draft }
        : {
            ...state,
            phase: "draft",
            draft: event.draft,
            generation: event.provenance,
            draftStale: false,
            manualEdits: false,
          }

    case "GENERATE_FAILED":
      // Back to review, not to an error dead end: the timeline is intact and the
      // manual-template path is still available from there.
      return { ...state, phase: "review", error: event.error }

    case "DRAFT_EDITED":
      return state.draft
        ? {
            ...state,
            draft: { ...state.draft, ...event.patch },
            manualEdits: true,
          }
        : state

    case "MERGE_CANDIDATE":
      return {
        ...state,
        draft: event.draft,
        candidateDraft: null,
        draftStale: false,
      }

    case "DISCARD_CANDIDATE":
      return { ...state, candidateDraft: null }

    case "SAVE_REQUESTED":
      return { ...state, phase: "saving", error: null }

    case "SAVED":
      return { ...state, phase: "saved", savedSkillId: event.skillId }

    case "SAVE_FAILED":
      // Back to the draft with everything intact — the save transaction rolled
      // back, so nothing the user wrote is gone.
      return { ...state, phase: "draft", error: event.error }

    case "TRIAL_STARTED":
      return { ...state, trialSessionId: event.sessionId }

    case "TRIAL_CONFIRMED":
      return { ...state, trialConfirmed: true }

    case "INTERRUPT":
      if (state.phase === "idle") return state
      return {
        ...state,
        phase: "interrupted",
        interrupt: {
          reason: event.reason,
          from: state.phase,
          retriable: interruptIsRetriable(event.reason),
        },
      }

    case "RETRY": {
      const interrupt = state.interrupt
      if (!interrupt || !interrupt.retriable) return state
      return {
        ...state,
        phase: recoveryPhaseFor(interrupt.from, state.steps.length > 0),
        interrupt: null,
        error: null,
      }
    }

    case "REATTACH":
      return event.snapshot

    case "CLOSE":
      return INITIAL_SNAPSHOT
  }
}

/** Is a native capture session live? Drives "do not close, stop first" copy. */
export function hasLiveCapture(phase: RecorderPhase): boolean {
  return phase === "recording" || phase === "paused" || phase === "stopping"
}

/** Phases where dismissing the Sheet must not tear the session down. */
export function sheetDismissKeepsSession(phase: RecorderPhase): boolean {
  return hasLiveCapture(phase)
}
