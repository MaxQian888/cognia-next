/**
 * The recorder's single live state.
 *
 * A store rather than a hook, for reasons that are all the same reason: there is
 * exactly one recording, and far more than one thing that needs to see it.
 * Four entry points on four routes, a native event channel that fires while no
 * component is mounted, startup recovery, the plugin's `record_skill_status`
 * agent tool, and a floating window in another process — none of which can share
 * React state. `getState()` reaches all of them with no prop plumbing.
 *
 * It also has to survive the Sheet unmounting: dismissing the Sheet mid-capture
 * leaves the recording running behind the floating controller, so per-mount
 * state would lose the session the moment the user clicked away.
 *
 * The store is a **reducer plus a snapshot**. Every phase change goes through
 * `reduceRecorder`; all the async work lives in `controller.ts`. That split is
 * what keeps tests free of `act(...)` warnings — they drive the controller and
 * `await` it, instead of racing a floating promise inside an effect.
 */

import { create } from "zustand"

import {
  INITIAL_SNAPSHOT,
  reduceRecorder,
  type RecorderEntrySource,
  type RecorderEvent,
  type RecorderSnapshot,
  type RecorderStage,
} from "@/lib/skills/recording/state-machine"
import {
  applyStepEdits,
  type RecordedStepView,
  type StepEdits,
} from "@/lib/skills/recording/step-model"
import type { RecordPreflight, RecordedStep } from "@/lib/skills/recording/types"

/** Per-recording choices made on the setup stage. */
export interface RecorderOptions {
  captureScreenshots: boolean
  /** `null` = use the configured Utility model. */
  modelOverride: { provider: string; model: string } | null
  /** `null` = use the current UI locale. */
  localeOverride: string | null
}

export const DEFAULT_RECORDER_OPTIONS: RecorderOptions = {
  captureScreenshots: true,
  modelOverride: null,
  localeOverride: null,
}

/** View state that is never persisted and never leaves this session. */
interface RecorderUiState {
  sheetOpen: boolean
  /** Narrow layouts show one pane at a time. */
  detailView: "timeline" | "detail"
  splitPercent: number
  selectedStepSeq: number | null
  /** Which stage the user is looking at; usually derived, but they can go back. */
  stageOverride: RecorderStage | null
}

export interface RecorderStoreState extends RecorderSnapshot, RecorderUiState {
  /** Raw capture, as it arrives. Edits are applied over it for display. */
  capturedSteps: RecordedStep[]
  edits: StepEdits
  /** Memoized `applyStepEdits(capturedSteps, edits)`. */
  steps: RecordedStepView[]
  options: RecorderOptions
  preflight: RecordPreflight | null
  /** What happened to the model's proposed tools, awaiting confirmation. */
  toolsConfirmed: boolean

  dispatch: (event: RecorderEvent) => boolean
  setUi: (patch: Partial<RecorderUiState>) => void
  setOptions: (patch: Partial<RecorderOptions>) => void
  setPreflight: (preflight: RecordPreflight | null) => void
  setCapturedSteps: (steps: RecordedStep[]) => void
  appendStep: (step: RecordedStep) => void
  dropStep: (seq: number) => void
  setEdits: (edits: StepEdits) => void
  setToolsConfirmed: (confirmed: boolean) => void
  reset: () => void
}

const INITIAL_UI: RecorderUiState = {
  sheetOpen: false,
  detailView: "timeline",
  // 42/58 — the timeline is a scannable index, the detail pane is where the
  // work happens.
  splitPercent: 42,
  selectedStepSeq: null,
  stageOverride: null,
}

/**
 * Recompute the display list.
 *
 * Done eagerly on every mutation rather than in a selector: the review timeline
 * is virtualized and re-deriving 400 views inside a render would be the one
 * place this costs anything.
 */
function withDerivedSteps(
  captured: RecordedStep[],
  edits: StepEdits
): Pick<RecorderStoreState, "capturedSteps" | "edits" | "steps"> {
  return { capturedSteps: captured, edits, steps: applyStepEdits(captured, edits) }
}

export const useRecorderStore = create<RecorderStoreState>((set, get) => ({
  ...INITIAL_SNAPSHOT,
  ...INITIAL_UI,
  capturedSteps: [],
  edits: { bySeq: {}, manual: [] },
  steps: [],
  options: DEFAULT_RECORDER_OPTIONS,
  preflight: null,
  toolsConfirmed: false,

  /**
   * Apply one event. Returns whether it was legal.
   *
   * An illegal transition is a UI bug — an action offered in a phase that does
   * not have it — so it warns in development rather than failing silently, but
   * it never throws: a stray native event arriving a beat late must not take the
   * app down.
   */
  dispatch: (event) => {
    const state = get()
    const next = reduceRecorder(state, event)
    if (!next) {
      if (process.env.NODE_ENV !== "production") {
        console.warn(
          `[recorder] ignored ${event.type} in phase "${state.phase}" — no such transition`
        )
      }
      return false
    }
    // `OPEN` is also what raises the Sheet, including the reattach case where
    // the phase does not change.
    const sheetOpen =
      event.type === "OPEN" ? true : event.type === "CLOSE" ? false : state.sheetOpen
    set({ ...next, sheetOpen })
    return true
  },

  setUi: (patch) => set(patch),
  setOptions: (patch) => set((state) => ({ options: { ...state.options, ...patch } })),
  setPreflight: (preflight) => set({ preflight }),

  setCapturedSteps: (steps) => set(withDerivedSteps(steps, get().edits)),

  appendStep: (step) =>
    set((state) => withDerivedSteps([...state.capturedSteps, step], state.edits)),

  dropStep: (seq) =>
    set((state) =>
      withDerivedSteps(
        state.capturedSteps.filter((step) => step.seq !== seq),
        state.edits
      )
    ),

  setEdits: (edits) => set((state) => withDerivedSteps(state.capturedSteps, edits)),

  setToolsConfirmed: (toolsConfirmed) => set({ toolsConfirmed }),

  reset: () =>
    set({
      ...INITIAL_SNAPSHOT,
      ...INITIAL_UI,
      capturedSteps: [],
      edits: { bySeq: {}, manual: [] },
      steps: [],
      options: DEFAULT_RECORDER_OPTIONS,
      preflight: null,
      toolsConfirmed: false,
    }),
}))

/**
 * Imperative entry point for the callers that are not React components — the
 * slash-command handler, the command palette item, the app shortcut, and the
 * plugin's own command.
 */
export function openRecorder(source: RecorderEntrySource): void {
  useRecorderStore.getState().dispatch({ type: "OPEN", source })
}

/** What the plugin's `record_skill_status` agent tool reports. */
export function recorderStatusSnapshot(): {
  recording: boolean
  phase: string
  stepCount: number
} {
  const state = useRecorderStore.getState()
  return {
    recording: state.phase === "recording" || state.phase === "paused",
    phase: state.phase,
    stepCount: state.capturedSteps.length,
  }
}
