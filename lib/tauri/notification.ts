"use client"

import {
  isPermissionGranted,
  requestPermission,
  sendNotification as sendNative,
  type Options,
} from "@tauri-apps/plugin-notification"
import { isTauri } from "@/lib/tauri"

/** Check the current OS grant without surfacing a permission prompt. */
export async function checkNotificationPermission(): Promise<"granted" | "denied" | "default"> {
  if (!isTauri()) return "denied"
  try {
    return (await isPermissionGranted()) ? "granted" : "default"
  } catch (err) {
    console.warn("checkNotificationPermission failed", err)
    return "default"
  }
}

/**
 * Ensure the OS-level notification permission is granted. Returns the final
 * permission state ("granted" | "denied" | "default"). Safe to call on every
 * launch — no-op outside Tauri, and the OS prompt only shows once.
 */
export async function ensureNotificationPermission(): Promise<"granted" | "denied" | "default"> {
  if (!isTauri()) return "denied"
  try {
    const granted = await isPermissionGranted()
    if (granted) return "granted"
    const result = await requestPermission()
    return result
  } catch (err) {
    console.warn("ensureNotificationPermission failed", err)
    return "default"
  }
}

/**
 * Send a native OS notification. Silently degrades to a no-op outside Tauri
 * (callers should also fire a `sonner` toast for in-app feedback).
 */
export async function notify(opts: Options | string): Promise<void> {
  if (!isTauri()) return
  try {
    sendNative(opts)
  } catch (err) {
    console.warn("notify failed", err)
  }
}
