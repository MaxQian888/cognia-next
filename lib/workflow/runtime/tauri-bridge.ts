/**
 * Tauri IPC bridge — thin wrappers around the IPC contract documented in the
 * plan (workflow_persist_run_state, workflow_register_trigger, etc.).
 *
 * The Rust commands are live (see `src-tauri/src/workflow/commands.rs`); these
 * wrappers no-op gracefully when running outside Tauri so the orchestrator can
 * still run end-to-end in web mode (cron / webhook triggers and crash-resume
 * are simply absent there).
 *
 * `lib/tauri.ts:isTauri()` is the canonical detection helper used elsewhere
 * in the app — we mirror it here.
 */

import type {
  InFlightRunRow,
  PersistRunStateInput,
  RegisterTriggerInput,
} from "@/types/workflow/visual"
import { notifyCompanionsOfRunState } from "./companion-run-events"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"

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
  // ADR 0061 P2 — fan the transition out to paired devices (live WS frame,
  // sync invalidate on terminal, push policy). Fire-and-forget: companion
  // delivery must never block or fail the orchestrator's persistence path.
  void notifyCompanionsOfRunState(input)
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
 * Returns the http URL that fires a registered webhook trigger. The Rust
 * router binds to an ephemeral 127.0.0.1 port, so the URL is only known
 * after `register_trigger` has been called for the same `triggerId`.
 *
 * In web mode (no Tauri) this returns null — the inspector form surfaces
 * a "desktop-only" hint in that case.
 */
export async function getWebhookUrl(triggerId: string): Promise<string | null> {
  const result = await safeInvoke<string | null>("workflow_get_webhook_url", { triggerId })
  return result ?? null
}

/**
 * Subscribe to Rust-side trigger events. Returns an unsubscribe function.
 * In web mode, returns a no-op unsubscribe immediately.
 *
 * The unsubscribe is wrapped in `safeUnlisten` — Tauri's injected
 * `unregisterListener` throws (as an unhandled rejection) when the
 * registration eval hasn't landed yet, which React StrictMode's
 * mount→unmount→mount cycle reliably triggers.
 */
export async function listenTriggerEvents(handler: (event: unknown) => void): Promise<() => void> {
  if (!isTauri()) return () => undefined
  try {
    const mod = await import("@tauri-apps/api/event")
    const stop = await mod.listen("workflow:trigger", (e) => handler(e.payload))
    return () => safeUnlisten(stop)
  } catch {
    return () => undefined
  }
}

/**
 * Deliver a dynamic response to a webhook request the Rust receiver is holding
 * open (the workflow reached an `io.webhook.respond` node). `correlationId`
 * comes from the trigger payload. Returns true when a request was still
 * waiting; false in web mode or when the request already timed out.
 */
export async function respondToWebhook(
  correlationId: string,
  response: { status: number; body: string; headers?: Record<string, string> }
): Promise<boolean> {
  const ok = await safeInvoke<boolean>("workflow_webhook_respond", {
    correlationId,
    status: response.status,
    body: response.body,
    headers: response.headers ?? {},
  })
  return ok ?? false
}

export async function listenResumeEvents(handler: (event: unknown) => void): Promise<() => void> {
  if (!isTauri()) return () => undefined
  try {
    const mod = await import("@tauri-apps/api/event")
    const stop = await mod.listen("workflow:resume", (e) => handler(e.payload))
    return () => safeUnlisten(stop)
  } catch {
    return () => undefined
  }
}
