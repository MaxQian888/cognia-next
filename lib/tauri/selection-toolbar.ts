"use client"

import { invoke } from "@tauri-apps/api/core"

import { isTauri } from "@/lib/tauri"
import { SHORTCUT_LIST_COMMAND } from "@/lib/shortcuts/ipc"

export const SELECTION_TOOLBAR_LABEL = "selection-toolbar"
export const SELECTION_CANDIDATE_EVENT = "selection://candidate"
export const SELECTION_DISMISS_EVENT = "selection://dismiss"
export const SELECTION_STAGE_EVENT = "selection://stage"
export const SELECTION_SHORTCUT_EVENT = "selection://shortcut"
/**
 * Escape pressed while the toolbar held focus. Only sent when a focus-taking
 * sub-panel is open — otherwise Rust dismisses the toolbar directly.
 */
export const SELECTION_ESCAPE_EVENT = "selection://escape"
/** Main window → toolbar: an `awaits_result` action has settled. */
export const SELECTION_RESULT_EVENT = "selection://result"
/** Main window → toolbar: speech playback ticked or ended. */
export const SELECTION_SPEECH_EVENT = "selection://speech"
/** Toolbar → main window: stop the speech this candidate started. */
export const SELECTION_SPEECH_STOP_EVENT = "selection://speech-stop"
export const SELECTION_TOOLBAR_ENABLED_PREF = "selectionToolbar.enabled"
export const SELECTION_TOOLBAR_DISABLED_APPS_PREF = "selectionToolbar.disabledApps"

/**
 * Where the selected text came from, and therefore how much to trust it.
 *
 * `ocr` is a distinct variant rather than a flag beside the others because it
 * is a different trust level and it travels: this text can be handed to a
 * model or written into long-term memory, and both want to know that
 * recognition errors are ordinary here in a way they never are for text the
 * user selected in a real text control.
 */
export type SelectionOrigin = "accessibility" | "clipboard" | "ocr"

/**
 * Transparent breathing room reserved on every side of the capsule.
 *
 * The native window is `shadow(false)` and the page is `overflow: hidden`, so
 * anything painted outside the window box is simply cut — which is why the old
 * fixed 360x44 window amputated the capsule's `shadow-xl`. The window is now
 * measured as `content + 2 * SELECTION_SHADOW_PAD`, and Rust hit-tests the
 * content rects so this margin does not become a dead zone.
 */
export const SELECTION_SHADOW_PAD = 20

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
  /**
   * AX subrole of the element the text came from, e.g. `AXSecureTextField`.
   *
   * Drives behaviour only, and is never rendered: `AXTextArea` in a tooltip
   * would be developer output leaking into product copy, and it would mint a
   * dozen untranslatable strings. See `isActionSuppressed`.
   */
  sourceSubrole?: string
  /** Document URL when the source app exposes one (browsers). */
  sourceUrl?: string
}

/**
 * Mirrors the Rust `SelectionToolbarAction` enum. The payloads carried by the
 * contextual actions are UX hints, not authority: Rust re-parses the URL and
 * refuses any scheme but http/https, builds the `mailto:` itself, and encodes
 * the search query against its own engine table. A renderer-side classifier is
 * a filter, never a security boundary.
 */
export type SelectionToolbarAction =
  | { kind: "copy" }
  | { kind: "explain" }
  | { kind: "translate"; targetLocale: string }
  | { kind: "ask" }
  | { kind: "remember" }
  | { kind: "speak" }
  | { kind: "openLink"; url: string }
  | { kind: "composeEmail"; address: string }
  // No query: Rust already owns the live candidate, so echoing its text back
  // would just be a second copy to keep in sync.
  | { kind: "searchWeb"; engine: string }
  | { kind: "convertUnit" }

export interface SelectionStagePayload {
  candidate: ExternalSelectionCandidate
  action: SelectionToolbarAction
  /**
   * Whether handing off should also raise the main window. False for
   * remember/speak: both finish without the user ever looking at the app, and
   * yanking it forward would defeat the point.
   */
  focusMain: boolean
}

/** Why the toolbar is going away — drives whether the exit is animated. */
export type SelectionDismissReason = "interrupted" | "idle" | "completed"

export interface SelectionDismissPayload {
  reason: SelectionDismissReason
}

/** Which side of the selection the toolbar landed on. */
export type SelectionToolbarPlacement = "above" | "below"

export interface SelectionToolbarGeometry {
  placement: SelectionToolbarPlacement
}

export interface SelectionShortcutPayload {
  shortcutId: string
  candidateId: string
}

/** Outcome of a `remember` handoff, reported back by the main window. */
export interface SelectionResultPayload {
  candidateId: string
  ok: boolean
  /** Present when `ok` is false — e.g. `"pii_blocked"`. */
  reason?: string
}

export interface SelectionSpeechPayload {
  candidateId: string
  playing: boolean
  /** 0-1, or undefined when the provider reports no duration. */
  progress?: number
}

export interface SelectionToolbarStatus {
  running: boolean
  hasCandidate: boolean
}

const STOPPED_STATUS: SelectionToolbarStatus = { running: false, hasCandidate: false }

/**
 * Every command invoked from the **overlay** window, as opposed to the main
 * window's start/stop/status calls.
 *
 * The overlay runs under its own least-privilege capability
 * (`src-tauri/capabilities/selection-toolbar.json`), and the generated
 * all-commands grant does not reach it — that one hangs off `default`, which is
 * scoped `windows: ["main"]`. A command missing from
 * `permissions/selection-toolbar-app-commands.toml` still compiles and is
 * rejected at runtime with "Command not found", which is how the
 * content-hugging resize shipped with the toolbar permanently invisible.
 *
 * The wrappers below invoke *through* this map, and a Rust test
 * (`every_command_the_overlay_invokes_is_granted_to_its_window`) asserts the
 * TOML lists exactly these — so neither a missing grant nor an over-grant can
 * drift in unnoticed.
 */
export const OVERLAY_COMMANDS = {
  currentCandidate: "selection_toolbar_current_candidate",
  execute: "selection_toolbar_execute",
  finish: "selection_toolbar_finish",
  resize: "selection_toolbar_resize",
  reveal: "selection_toolbar_reveal",
  setInteractive: "selection_toolbar_set_interactive",
  setKeepAlive: "selection_toolbar_set_keep_alive",
  listShortcuts: SHORTCUT_LIST_COMMAND,
} as const

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
  return invoke<ExternalSelectionCandidate | null>(OVERLAY_COMMANDS.currentCandidate)
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
  await invoke(OVERLAY_COMMANDS.execute, { candidateId, action })
}

export async function revealSelectionToolbar(): Promise<void> {
  if (!isTauri()) return
  await invoke(OVERLAY_COMMANDS.reveal)
}

export async function setSelectionToolbarInteractive(interactive: boolean): Promise<void> {
  if (!isTauri()) return
  await invoke(OVERLAY_COMMANDS.setInteractive, { interactive })
}

/**
 * Size the native window to the measured content and re-anchor it.
 *
 * `width`/`height` are the whole window box (content + `SELECTION_SHADOW_PAD`
 * on each side) and `hitRects` are the opaque rects inside it — the capsule,
 * plus the language list while it is open. Rust hit-tests against those, so the
 * padding is not a dead zone *and* a click in the open list is not mistaken for
 * a click away. Returns the placement actually used, which can flip to `below`
 * once the real height is known.
 */
export async function resizeSelectionToolbar(
  width: number,
  height: number,
  hitRects: SelectionAnchorRect[]
): Promise<SelectionToolbarGeometry> {
  if (!isTauri()) return { placement: "above" }
  return invoke<SelectionToolbarGeometry>(OVERLAY_COMMANDS.resize, {
    width,
    height,
    hitRects,
  })
}

/** Freeze (or resume) the idle countdown — pointer hover, pending, speaking. */
export async function setSelectionToolbarKeepAlive(keepAlive: boolean): Promise<void> {
  if (!isTauri()) return
  await invoke(OVERLAY_COMMANDS.setKeepAlive, { keepAlive })
}

/** Report that a remember/speak action has settled, releasing the toolbar. */
export async function finishSelectionToolbar(candidateId: string): Promise<void> {
  if (!isTauri()) return
  await invoke(OVERLAY_COMMANDS.finish, { candidateId })
}

/**
 * Current chord for every bound shortcut, as `id → chord`.
 *
 * Read straight from Rust rather than through `useShortcutStore`: the toolbar
 * renders in an overlay window that deliberately mounts only the minimal shell
 * (`components/runtime/lightweight-route-shell.tsx`), so the app-wide stores are not
 * hydrated there. The capsule shows whatever the user has actually bound, which
 * is why this is a live read and not the hard-coded defaults. Skipping the store
 * is not a reason to skip `lib/shortcuts/` — the command and its shape live
 * there, in `ipc.ts`.
 */
export { getGlobalShortcutChords as listShortcutChords } from "@/lib/shortcuts/ipc"
