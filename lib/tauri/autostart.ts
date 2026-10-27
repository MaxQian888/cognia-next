"use client"

import {
  enable as enableNative,
  disable as disableNative,
  isEnabled as isEnabledNative,
} from "@tauri-apps/plugin-autostart"
import { isTauri } from "@/lib/platform/detect"

export const AUTOSTART_CHANGED_EVENT = "cognia:tray-autostart-changed"

/** Registration returned successfully, but the OS reported another state. */
export class AutostartStateMismatchError extends Error {
  constructor() {
    super("The autostart registration did not match the requested state")
    this.name = "AutostartStateMismatchError"
  }
}

// All entry points share this queue, including the read/modify/write of a tray
// toggle. A failed operation must not prevent later attempts from running.
let pending: Promise<unknown> = Promise.resolve()

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.then(operation)
  pending = result.catch(() => undefined)
  return result
}

/** Read the OS registration. A failed read is unknown, never "disabled". */
export function isAutostartEnabled(): Promise<boolean> {
  if (!isTauri()) return Promise.resolve(false)
  return enqueue(isEnabledNative)
}

async function writeAutostart(on: boolean): Promise<boolean> {
  if (on) await enableNative()
  else await disableNative()
  const actual = await isEnabledNative()
  broadcastAutostartChanged(actual)
  if (actual !== on) throw new AutostartStateMismatchError()
  return actual
}

/** Register the app to launch at user login. */
export async function enableAutostart(): Promise<void> {
  await setAutostart(true)
}

/** Remove the launch-at-login entry. */
export async function disableAutostart(): Promise<void> {
  await setAutostart(false)
}

/** Set and verify registration, then notify every local consumer. */
export async function setAutostart(on: boolean): Promise<void> {
  if (!isTauri()) return
  await enqueue(() => writeAutostart(on))
}

/** Atomically toggle relative to the latest registration in this webview. */
export function toggleAutostart(): Promise<boolean> {
  if (!isTauri()) return Promise.resolve(false)
  return enqueue(async () => writeAutostart(!(await isEnabledNative())))
}

/** Publish registration read back from the OS; inert without a DOM. */
export function broadcastAutostartChanged(on: boolean): void {
  if (typeof window === "undefined" || typeof CustomEvent === "undefined") return
  window.dispatchEvent(new CustomEvent(AUTOSTART_CHANGED_EVENT, { detail: on }))
}

export function onAutostartChanged(cb: (on: boolean) => void): () => void {
  if (typeof window === "undefined") return () => {}
  const handler = (event: Event) => cb(Boolean((event as CustomEvent<boolean>).detail))
  window.addEventListener(AUTOSTART_CHANGED_EVENT, handler)
  return () => window.removeEventListener(AUTOSTART_CHANGED_EVENT, handler)
}
