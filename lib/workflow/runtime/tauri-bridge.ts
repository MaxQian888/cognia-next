/**
 * Tauri IPC bridge — thin wrappers around the IPC contract documented in the
 * plan (workflow_persist_run_state, workflow_register_trigger, etc.).
 *
 * Phase 4 ships **stubs** that no-op when running outside Tauri. The Rust
 * commands themselves land in Phase 5a; until then, every function returns
 * gracefully so the orchestrator can run end-to-end in web mode.
 *
 * `lib/tauri.ts:isTauri()` is the canonical detection helper used elsewhere
 * in the app — we mirror it here.
 */

import type {
  InFlightRunRow,
  PersistRunStateInput,
  RegisterTriggerInput,
} from "@/types/workflow/visual"

let _isTauri: boolean | null = null

function isTauri(): boolean {
  if (_isTauri !== null) return _isTauri
  if (typeof window === "undefined") {
    _isTauri = false
  } else {
    _isTauri =
      "__TAURI__" in window ||
      "__TAURI_INTERNALS__" in window ||
      typeof (window as { __TAURI_IPC__?: unknown }).__TAURI_IPC__ !== "undefined"
  }
  return _isTauri
}

async function safeInvoke<T>(name: string, payload?: unknown): Promise<T | null> {
  if (!isTauri()) return null
  try {
    const mod = await import("@tauri-apps/api/core").catch(() => null)
    if (!mod) return null
    return (await mod.invoke(name, payload as Record<string, unknown>)) as T
  } catch {
    return null
  }
}

/** Persist (or upsert) a run-state mirror row in Rust's SQLite. */
export async function persistRunState(input: PersistRunStateInput): Promise<void> {
  await safeInvoke("workflow_persist_run_state", input)
}

/** Register / update a trigger row. Causes the Rust daemon to reload its schedule. */
export async function registerTrigger(input: RegisterTriggerInput): Promise<void> {
  await safeInvoke("workflow_register_trigger", input)
}

export async function unregisterTrigger(triggerId: string): Promise<void> {
  await safeInvoke("workflow_unregister_trigger", { triggerId })
}

/**
 * Called once on app boot — Rust returns rows whose status is still "running",
 * so the TS orchestrator can resume them from the durable Dexie event log.
 */
export async function reloadInFlightRuns(): Promise<InFlightRunRow[]> {
  const result = await safeInvoke<InFlightRunRow[]>("workflow_reload_in_flight_runs")
  return result ?? []
}

/** Called when a run terminates successfully so Rust can drop the mirror row. */
export async function ackRunCompleted(runId: string): Promise<void> {
  await safeInvoke("workflow_ack_completed", { runId })
}

/**
 * Subscribe to Rust-side trigger events. Returns an unsubscribe function.
 * In web mode, returns a no-op unsubscribe immediately.
 */
export async function listenTriggerEvents(handler: (event: unknown) => void): Promise<() => void> {
  if (!isTauri()) return () => undefined
  try {
    const mod = await import("@tauri-apps/api/event")
    const stop = await mod.listen("workflow:trigger", (e) => handler(e.payload))
    return stop
  } catch {
    return () => undefined
  }
}

export async function listenResumeEvents(handler: (event: unknown) => void): Promise<() => void> {
  if (!isTauri()) return () => undefined
  try {
    const mod = await import("@tauri-apps/api/event")
    const stop = await mod.listen("workflow:resume", (e) => handler(e.payload))
    return stop
  } catch {
    return () => undefined
  }
}
