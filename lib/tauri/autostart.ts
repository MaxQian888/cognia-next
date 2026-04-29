"use client"

import {
  enable as enableNative,
  disable as disableNative,
  isEnabled as isEnabledNative,
} from "@tauri-apps/plugin-autostart"
import { isTauri } from "@/lib/tauri"

/** Whether the OS-level "launch at login" entry is currently registered. */
export async function isAutostartEnabled(): Promise<boolean> {
  if (!isTauri()) return false
  try {
    return await isEnabledNative()
  } catch (err) {
    console.warn("isAutostartEnabled failed", err)
    return false
  }
}

/** Register the app to launch at user login. */
export async function enableAutostart(): Promise<void> {
  if (!isTauri()) return
  await enableNative()
}

/** Remove the launch-at-login entry. */
export async function disableAutostart(): Promise<void> {
  if (!isTauri()) return
  await disableNative()
}

/** Idempotent toggle helper for a single Settings switch. */
export async function setAutostart(on: boolean): Promise<void> {
  if (!isTauri()) return
  if (on) await enableNative()
  else await disableNative()
}
