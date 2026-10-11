"use client"

import { invoke } from "@tauri-apps/api/core"

import { isTauri } from "@/lib/tauri"
import { setAutostart } from "@/lib/tauri/autostart"
import { setCloseBehavior } from "@/lib/tauri/close-behavior"

/**
 * The desktop's always-on host mode (ADR-0224 A3).
 *
 * In host mode this desktop is the machine the account's bots, connectors and
 * scheduled tasks run on while the user is away: it holds a system wake
 * assertion, launches hidden at login, and its close button always goes to the
 * tray (the tray's Quit still exits).
 *
 * Rust owns the flag (`host-mode.json` in the app config dir,
 * `src-tauri/src/window_behavior.rs`): a login launch must decide to stay
 * hidden and to hold the machine awake before any renderer exists. That also
 * makes it device-local by construction; it is not an `AppSettings` field and
 * never syncs.
 *
 * Mirrors `HostModeStatus` in `window_behavior.rs`.
 */
export interface HostModeStatus {
  /** The persisted mode. */
  enabled: boolean
  /**
   * This process was a login launch in host mode and must not reveal the main
   * window at boot. Fixed for the life of the process.
   */
  bootHidden: boolean
}

export const HOST_MODE_OFF: HostModeStatus = Object.freeze({ enabled: false, bootHidden: false })

let snapshot: HostModeStatus = HOST_MODE_OFF
let loaded = false
let pending: Promise<HostModeStatus> | null = null
const listeners = new Set<() => void>()

function publish(next: HostModeStatus): HostModeStatus {
  const firstRead = !loaded
  loaded = true
  const changed = next.enabled !== snapshot.enabled || next.bootHidden !== snapshot.bootHidden
  if (changed) snapshot = next
  // The first read is news even when it says "off": readers waiting on
  // `hostModeLoaded` must hear it.
  if (changed || firstRead) for (const listener of listeners) listener()
  return snapshot
}

/** The last known status. `HOST_MODE_OFF` until the first read lands. */
export function readHostMode(): HostModeStatus {
  return snapshot
}

/** Whether the status has been read from Rust at least once. */
export function hostModeLoaded(): boolean {
  return loaded
}

export function subscribeHostMode(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Read the status from Rust. Concurrent callers share one request. Outside
 * the desktop shell the mode does not exist and reads as off.
 */
export function refreshHostMode(): Promise<HostModeStatus> {
  if (!isTauri()) return Promise.resolve(publish(HOST_MODE_OFF))
  pending ??= invoke<HostModeStatus>("host_mode_get")
    .then(publish)
    .finally(() => {
      pending = null
    })
  return pending
}

/**
 * Turn the mode on or off. Turning it on also registers launch at login and
 * sets the close button to the tray, so the stored preference matches what the
 * host does; turning it off leaves both as they are, since the user may still
 * want them. Throws when Rust could not persist the mode.
 */
export async function setHostMode(enabled: boolean): Promise<HostModeStatus> {
  if (!isTauri()) return publish(HOST_MODE_OFF)
  const next = publish(await invoke<HostModeStatus>("host_mode_set", { enabled }))
  if (enabled) {
    await setAutostart(true)
    await setCloseBehavior("tray")
  }
  return next
}

/** Test-only: forget the cached status. */
export function __resetHostModeForTests(): void {
  snapshot = HOST_MODE_OFF
  loaded = false
  pending = null
  listeners.clear()
}
