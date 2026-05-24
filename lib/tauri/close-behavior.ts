"use client"

import { invoke } from "@tauri-apps/api/core"
import { getPref, setPref } from "@/lib/tauri/store"

/**
 * What happens when the user clicks the main window's close (X) button.
 *
 *  - `ask`  — show the exit-confirmation dialog
 *  - `tray` — minimize to the system tray, keep the app running
 *  - `quit` — quit the app
 *
 * Mirrors the Rust `CloseBehavior` enum in `src-tauri/src/window_behavior.rs`.
 */
export type CloseBehavior = "ask" | "tray" | "quit"

/** Store key for the tri-state close behavior. */
export const CLOSE_BEHAVIOR_PREF = "exit.close-behavior"

/**
 * Legacy boolean key for "minimize to tray on close". Read once for migration:
 * an existing `true` becomes `tray` so users keep their habit; anything else
 * falls through to the new `ask` default.
 */
export const LEGACY_TRAY_ON_CLOSE_PREF = "tray.minimize-on-close"

const BEHAVIORS: readonly CloseBehavior[] = ["ask", "tray", "quit"]

function isCloseBehavior(value: unknown): value is CloseBehavior {
  return typeof value === "string" && (BEHAVIORS as readonly string[]).includes(value)
}

/**
 * Read the persisted close behavior, migrating the legacy boolean preference
 * on first run. Defaults to `ask` outside Tauri or when nothing is stored.
 */
export async function getCloseBehavior(): Promise<CloseBehavior> {
  const stored = await getPref<CloseBehavior>(CLOSE_BEHAVIOR_PREF)
  if (isCloseBehavior(stored)) return stored

  const legacy = await getPref<boolean>(LEGACY_TRAY_ON_CLOSE_PREF)
  return legacy === true ? "tray" : "ask"
}

/** Push the behavior into Rust without persisting — used for boot-time sync. */
export async function pushCloseBehaviorToRust(behavior: CloseBehavior): Promise<void> {
  await invoke("set_close_behavior", { behavior })
}

/**
 * Persist the behavior and push it into Rust so the close-requested handler
 * reflects the new choice on the very next close event.
 */
export async function setCloseBehavior(behavior: CloseBehavior): Promise<void> {
  await setPref(CLOSE_BEHAVIOR_PREF, behavior)
  await pushCloseBehaviorToRust(behavior)
}

/** The action the user picked in the exit-confirmation dialog. */
export type CloseAction = "minimize" | "quit" | "cancel"

/**
 * Tell Rust how to resolve a pending close request. Window manipulation stays
 * Rust-side (`resolve_close_request`) to mirror the tray-on-close path.
 */
export async function resolveCloseRequest(action: CloseAction): Promise<void> {
  await invoke("resolve_close_request", { action })
}
