"use client"

import { invoke } from "@tauri-apps/api/core"

import { isTauri } from "@/lib/tauri"

/**
 * Renderer half of the runtime white-screen watchdog (the Rust half lives in
 * `src-tauri/src/webview_watchdog.rs`).
 *
 * The watchdog can't see *into* the webview, so the renderer proves it's alive
 * by beating a heartbeat the Rust polling loop monitors. The trick that makes
 * this reliable is that the interval is installed at **module scope**, not in a
 * React effect: it survives every React unmount — the route error boundary, and
 * critically the `app/global-error.tsx` swap (which unmounts the entire layout
 * but keeps the same JS realm, so it keeps beating and the watchdog correctly
 * leaves the legit error UI alone). It stops only when the JS realm itself dies
 * or freezes — a renderer-process crash, an OOM/GPU kill, a hung main thread, or
 * a navigation to a blank document — which is exactly the white-screen condition
 * the watchdog reloads.
 */

/** How often the renderer beats. Comfortably under the Rust 15s timeout. */
export const HEARTBEAT_INTERVAL_MS = 4000

let started = false

/** Send one heartbeat. Best-effort — a failing IPC must never throw into the app. */
async function beat(): Promise<void> {
  try {
    await invoke("webview_heartbeat", { url: window.location.href })
  } catch {
    // IPC unavailable / mid-teardown — the next tick retries.
  }
}

/**
 * Start the realm-lifetime heartbeat. Idempotent and intentionally never torn
 * down (no cleanup handle is returned): the interval must outlive the React tree
 * that started it. No-op off Tauri or during SSR.
 */
export function startWebviewHeartbeat(): void {
  if (started || typeof window === "undefined" || !isTauri()) return
  started = true
  void beat()
  window.setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS)
}

/**
 * Ask Rust whether this page load was an automatic recovery from a blank screen,
 * clearing the flag. The freshly-loaded renderer uses this to toast the user —
 * the only moment a "we recovered you" prompt is deliverable, since the
 * pre-reload page was dead. Returns false off Tauri or on any error.
 */
export async function takeWhiteScreenRecoveryNotice(): Promise<boolean> {
  if (!isTauri()) return false
  try {
    return await invoke<boolean>("webview_take_recovery_notice")
  } catch {
    return false
  }
}

/** Test-only reset of the module-level start guard. */
export function __resetWebviewHeartbeatForTests(): void {
  started = false
}
