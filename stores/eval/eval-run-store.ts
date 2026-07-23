"use client"

/**
 * The in-flight eval run.
 *
 * Run state used to live in `RunConfigDialog`'s component state, which made
 * three things impossible:
 *
 *  - **Cancelling early.** The cancel button was gated on the first progress
 *    tick, so during case 1 — which on a real target can be minutes — there was
 *    no way out.
 *  - **Leaving the dialog.** Closing it unmounted the component and dropped the
 *    AbortController, but the promise kept running and kept writing to Dexie.
 *    The run became unobservable and uncancellable rather than stopping.
 *  - **Seeing it from anywhere else.** Switching to the Compare or Calibrate
 *    tab hid a run that was still burning tokens.
 *
 * Deliberately NOT persisted: an AbortController cannot be serialized, and a
 * "running" flag that survives a reload would describe a run that no longer
 * exists. Durable run state lives on the `evalRuns` row's `status`, which the
 * runner writes before it starts and overwrites when it settles.
 */

import { create } from "zustand"
import type { EvalProgress } from "@/lib/ai/eval/service"

export interface ActiveEvalRun {
  datasetId: string
  /** Human label for the target matrix, for the status bar. */
  label: string
  progress: EvalProgress | null
  /** Set while the run is being torn down, so the UI can stop offering cancel. */
  cancelling: boolean
}

interface EvalRunState {
  active: ActiveEvalRun | null
  /** Non-serializable, so it is kept outside the rendered state. */
  controller: AbortController | null
  start: (input: { datasetId: string; label: string; controller: AbortController }) => void
  updateProgress: (progress: EvalProgress) => void
  cancel: () => void
  finish: () => void
}

export const useEvalRunStore = create<EvalRunState>((set, get) => ({
  active: null,
  controller: null,

  start: ({ datasetId, label, controller }) =>
    set({
      active: { datasetId, label, progress: null, cancelling: false },
      controller,
    }),

  updateProgress: (progress) => set((s) => (s.active ? { active: { ...s.active, progress } } : {})),

  cancel: () => {
    get().controller?.abort()
    set((s) => (s.active ? { active: { ...s.active, cancelling: true } } : {}))
  },

  finish: () => set({ active: null, controller: null }),
}))
