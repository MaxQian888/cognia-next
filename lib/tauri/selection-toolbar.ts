"use client"

import { invoke } from "@tauri-apps/api/core"

import { isTauri } from "@/lib/tauri"

export const SELECTION_CANDIDATE_EVENT = "selection://candidate"
export const SELECTION_DISMISS_EVENT = "selection://dismiss"
export const SELECTION_STAGE_EVENT = "selection://stage"
export const SELECTION_TOOLBAR_ENABLED_PREF = "selectionToolbar.enabled"
export const SELECTION_TOOLBAR_DISABLED_APPS_PREF = "selectionToolbar.disabledApps"

export type SelectionOrigin = "accessibility" | "clipboard"

export interface SelectionAnchorRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ExternalSelectionCandidate {
  id: string
  text: string
  sourceApp: string
  sourceTitle?: string
  origin: SelectionOrigin
  anchorRect?: SelectionAnchorRect
  capturedAt: number
  truncated: boolean
}

export type SelectionToolbarAction =
  | { kind: "copy" }
  | { kind: "explain" }
  | { kind: "translate"; targetLocale: string }
  | { kind: "ask" }

export interface SelectionStagePayload {
  candidate: ExternalSelectionCandidate
  action: SelectionToolbarAction
}

export interface SelectionToolbarStatus {
  running: boolean
  hasCandidate: boolean
}

const STOPPED_STATUS: SelectionToolbarStatus = { running: false, hasCandidate: false }

export async function startSelectionToolbar(
  disabledApps: string[] = []
): Promise<SelectionToolbarStatus> {
  if (!isTauri()) return STOPPED_STATUS
  return invoke<SelectionToolbarStatus>("selection_toolbar_start", {
    args: { disabledApps },
  })
}

export async function stopSelectionToolbar(): Promise<SelectionToolbarStatus> {
  if (!isTauri()) return STOPPED_STATUS
  return invoke<SelectionToolbarStatus>("selection_toolbar_stop")
}

export async function getSelectionToolbarStatus(): Promise<SelectionToolbarStatus> {
  if (!isTauri()) return STOPPED_STATUS
  return invoke<SelectionToolbarStatus>("selection_toolbar_status")
}

export async function getCurrentSelectionCandidate(): Promise<ExternalSelectionCandidate | null> {
  if (!isTauri()) return null
  return invoke<ExternalSelectionCandidate | null>("selection_toolbar_current_candidate")
}

export async function captureClipboardSelection(): Promise<ExternalSelectionCandidate | null> {
  if (!isTauri()) return null
  return invoke<ExternalSelectionCandidate | null>("selection_toolbar_capture_clipboard")
}

export async function takePendingSelectionStage(): Promise<SelectionStagePayload | null> {
  if (!isTauri()) return null
  return invoke<SelectionStagePayload | null>("selection_toolbar_take_pending_stage")
}

export async function executeSelectionToolbarAction(
  candidateId: string,
  action: SelectionToolbarAction
): Promise<void> {
  if (!isTauri()) return
  await invoke("selection_toolbar_execute", { candidateId, action })
}

export async function revealSelectionToolbar(): Promise<void> {
  if (!isTauri()) return
  await invoke("selection_toolbar_reveal")
}

export async function setSelectionToolbarInteractive(interactive: boolean): Promise<void> {
  if (!isTauri()) return
  await invoke("selection_toolbar_set_interactive", { interactive })
}
