"use client"

/**
 * Selector facade over the recorder store.
 *
 * Components read through this rather than reaching into the store directly, so
 * the set of things a component can subscribe to is small and named. The
 * array-valued selectors go through `useShallow` — without it, `steps` returns a
 * fresh array identity on every store write and React 19 + zustand v5 spin
 * (the same update loop `skill-panel-toolbar.tsx` documents).
 */

import { useSyncExternalStore } from "react"
import { useShallow } from "zustand/react/shallow"

import {
  getRecorderAvailability,
  subscribeRecorderAvailability,
} from "@/lib/skills/recording/recorder-availability"
import { stageForPhase, unconfirmedVariableCount } from "@/lib/skills/recording/state-machine"
import { includedSteps } from "@/lib/skills/recording/step-model"
import { useRecorderStore } from "@/stores/skills/recorder-store"

/** Whether the owning plugin is enabled. Every entry point gates on this. */
export function useRecorderAvailable(): boolean {
  return useSyncExternalStore(
    subscribeRecorderAvailability,
    () => getRecorderAvailability().available,
    // Server render: the plugin is desktop-only, so it is never available there.
    () => false
  )
}

export function useRecorderPhase() {
  return useRecorderStore((state) => state.phase)
}

export function useRecorderStage() {
  return useRecorderStore((state) => state.stageOverride ?? stageForPhase(state.phase))
}

export function useRecorderSheetOpen(): boolean {
  return useRecorderStore((state) => state.sheetOpen)
}

export function useRecorderSteps() {
  return useRecorderStore(useShallow((state) => state.steps))
}

export function useRecorderIncludedCount(): number {
  return useRecorderStore((state) => includedSteps(state.steps).length)
}

export function useRecorderVariables() {
  return useRecorderStore(useShallow((state) => state.inputVariables))
}

export function useRecorderUsage() {
  return useRecorderStore(useShallow((state) => state.usage))
}

export function useRecorderDraft() {
  return useRecorderStore((state) => state.draft)
}

export function useRecorderCandidate() {
  return useRecorderStore((state) => state.candidateDraft)
}

export function useRecorderPreflight() {
  return useRecorderStore((state) => state.preflight)
}

export function useRecorderError() {
  return useRecorderStore((state) => state.error)
}

export function useRecorderInterrupt() {
  return useRecorderStore((state) => state.interrupt)
}

export function useRecorderOptions() {
  return useRecorderStore(useShallow((state) => state.options))
}

/**
 * Variable suggestions still awaiting an answer.
 *
 * Drives the generation gate's copy as well as the disabled state, so the user
 * is told how many decisions are outstanding rather than facing a dead button.
 */
export function useRecorderUnconfirmedVariables(): number {
  return useRecorderStore((state) => unconfirmedVariableCount(state))
}

export function useRecorderSelectedStep() {
  return useRecorderStore(
    (state) => state.steps.find((step) => step.seq === state.selectedStepSeq) ?? null
  )
}
