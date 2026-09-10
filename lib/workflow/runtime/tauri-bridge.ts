/**
 * Native workflow bridge: thin wrappers around the Rust workflow state
 * (`crates/cognia-scheduling/src/workflow/commands.rs`): the run-state mirror
 * the crash-resume path reads, the cron and file-watch daemons, the webhook
 * router and the durable waitpoint mirror.
 *
 * Every native call goes through the shared `transport`, and only on a host
 * that owns a workflow state: the desktop (`TauriTransport`, so `invoke`) or
 * the headless brain (`CompanionTransport` on cognia-server's internal plane,
 * answered by the service-scope arms in `rpc/service_plane.rs`). A paired
 * phone or browser and a standalone web tab have no such state, so there the
 * wrappers answer `null` and the orchestrator runs without triggers and
 * without crash-resume.
 *
 * This file used to import `@tauri-apps/api/core` directly and treat
 * everything that was not a Tauri webview as "web mode". On the headless brain
 * that made every mirror write vanish, so cognia-server ran a cron daemon and
 * a webhook router nobody ever registered a trigger with. Host reachability
 * is decided on the host profile now, the same way the agent chain decides it.
 */

import type {
  InFlightRunRow,
  PersistRunStateInput,
  RegisterTriggerInput,
} from "@/types/workflow/visual"
import { notifyCompanionsOfRunState } from "./companion-run-events"
import { detectHostProfile } from "@/lib/platform/capabilities"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"
import type {
  WorkflowWaitEvent,
  WorkflowWaitpoint,
  WorkflowWaitpointResolution,
  WorkflowWaitpointStatus,
} from "@/types/workflow/waitpoint"

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

/**
 * Whether this shell can reach a Rust workflow state at all: the desktop's own
 * managed `WorkflowState`, or the one cognia-server opened for the brain. The
 * command manifest declares these commands service-only, so a companion
 * transport would refuse them before the wire; answering `null` here is the
 * same refusal without the round trip.
 */
function hasNativeWorkflowPlane(): boolean {
  const profile = detectHostProfile()
  return profile === "desktop" || profile === "headless"
}

/** Commands whose failure has already been reported once in this process. */
const reportedFailures = new Set<string>()

async function safeInvoke<T>(name: string, payload?: Record<string, unknown>): Promise<T | null> {
  if (!hasNativeWorkflowPlane()) return null
  try {
    const { transport } = await import("@/lib/tauri")
    return (await transport.call<T>(name, payload)) as T
  } catch (error) {
    // A host that HAS a native plane and still failed is the case worth
    // hearing about. The previous blanket `catch {}` is how a bare object sent
    // to a command that wants `{ input }` went unnoticed: every persist was
    // refused with "missing required key input" and the mirror stayed empty.
    // Once per command, so a persist failing on every step transition does
    // not flood the log.
    if (!reportedFailures.has(name)) {
      reportedFailures.add(name)
      console.warn(
        `workflow bridge: ${name} failed on this host; the native mirror is behind`,
        error
      )
    }
    return null
  }
}

/** Persist (or upsert) a run-state mirror row in Rust's SQLite. */
export async function persistRunState(input: PersistRunStateInput): Promise<void> {
  // `{ input }`, not the bare object: Tauri reads each command argument by
  // name out of the payload, and `workflow_persist_run_state` takes a single
  // argument called `input`. The bare object was refused on every call.
  await safeInvoke("workflow_persist_run_state", { input })
  // ADR 0061 P2 — fan the transition out to paired devices (live WS frame,
  // sync invalidate on terminal, push policy). Fire-and-forget: companion
  // delivery must never block or fail the orchestrator's persistence path.
  void notifyCompanionsOfRunState(input)
}

/** Register / update a trigger row. Causes the Rust daemon to reload its schedule. */
export async function registerTrigger(input: RegisterTriggerInput): Promise<void> {
  // Same `{ input }` wrapping as `persistRunState`: the daemon never saw a
  // cron, webhook or file-watch registration while this sent the bare object.
  await safeInvoke("workflow_register_trigger", { input })
}

export async function unregisterTrigger(workflowId: string, triggerId: string): Promise<void> {
  await safeInvoke("workflow_unregister_trigger", { workflowId, triggerId })
}

/**
 * Tell the file-watch daemon the run it started has finished.
 *
 * Half of what the mute needs; the daemon also waits for `settleMs` of quiet,
 * so a run whose writes are still landing keeps its own watch muted even after
 * this returns. `safeInvoke` no-ops off Tauri, and the daemon's mute timeout
 * covers a lost ack, so a failure here costs a late re-arm rather than a
 * stuck trigger.
 */
export async function ackFileWatch(workflowId: string, triggerId: string): Promise<void> {
  await safeInvoke("workflow_file_watch_ack", { workflowId, triggerId })
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

function terminalStatus(resolution: WorkflowWaitpointResolution): WorkflowWaitpointStatus {
  switch (resolution.outcome) {
    case "rejected":
      return "rejected"
    case "timed_out":
      return "timed_out"
    case "cancelled":
      return "cancelled"
    default:
      return "resolved"
  }
}

export function createNativeWorkflowWaitpoint(
  waitpoint: WorkflowWaitpoint
): Promise<WorkflowWaitpoint | null> {
  return safeInvoke<WorkflowWaitpoint>("workflow_waitpoint_create", { waitpoint })
}

export function getNativeWorkflowWaitpoint(id: string): Promise<WorkflowWaitpoint | null> {
  return safeInvoke<WorkflowWaitpoint | null>("workflow_waitpoint_get", { waitpointId: id })
}

export function listNativePendingWorkflowWaitpoints(): Promise<WorkflowWaitpoint[] | null> {
  return safeInvoke<WorkflowWaitpoint[]>("workflow_waitpoint_list_pending")
}

export function decideNativeWorkflowWaitpoint(
  id: string,
  resolution: WorkflowWaitpointResolution
): Promise<boolean | null> {
  return safeInvoke<boolean>("workflow_waitpoint_decide", {
    input: {
      id,
      status: terminalStatus(resolution),
      resolution,
      updatedAt: resolution.resolvedAt,
    },
  })
}

export async function persistNativeWorkflowWaitEvent(event: WorkflowWaitEvent): Promise<void> {
  await safeInvoke("workflow_wait_event_persist", { event })
}

export function pruneNativeWorkflowWaitEvents(now: number): Promise<number | null> {
  return safeInvoke<number>("workflow_wait_event_prune", { now })
}

/**
 * Returns the http URL that fires a registered webhook trigger. The Rust
 * router binds to an ephemeral 127.0.0.1 port, so the URL is only known
 * after `register_trigger` has been called for the same workflow and trigger.
 *
 * In web mode (no Tauri) this returns null — the inspector form surfaces
 * a "desktop-only" hint in that case.
 */
export async function getWebhookUrl(workflowId: string, triggerId: string): Promise<string | null> {
  const result = await safeInvoke<string | null>("workflow_get_webhook_url", {
    workflowId,
    triggerId,
  })
  return result ?? null
}

/**
 * Subscribe to Rust-side trigger events. Returns an unsubscribe function.
 *
 * Host neutrality: on the Tauri desktop this is a Tauri event listener; on
 * every other host it subscribes through the active `Transport` — the
 * headless brain's `CompanionTransport` (`/internal/events`) subscribes to the
 * `workflow:trigger` channel that cognia-server's Rust cron daemon and webhook
 * router publish (`HeadlessWorkflowEmitter`), and a companion device on
 * `/ws/events` likewise. Hosts whose transport has no event plane (the web
 * stub) return a no-op unsubscribe.
 *
 * The Tauri unsubscribe is wrapped in `safeUnlisten` — Tauri's injected
 * `unregisterListener` throws (as an unhandled rejection) when the
 * registration eval hasn't landed yet, which React StrictMode's
 * mount→unmount→mount cycle reliably triggers.
 */
export async function listenTriggerEvents(handler: (event: unknown) => void): Promise<() => void> {
  if (!isTauri()) return subscribeViaTransport("workflow:trigger", handler)
  try {
    const mod = await import("@tauri-apps/api/event")
    const stop = await mod.listen("workflow:trigger", (e) => handler(e.payload))
    return () => safeUnlisten(stop)
  } catch {
    return () => undefined
  }
}

/**
 * Subscribe to a host event channel through the process-wide transport
 * (`lib/tauri` live binding, so a headless/CLI host that swapped the transport
 * is honoured). Returns a no-op unsubscribe when the transport cannot deliver
 * events (web stub) or the subscription throws.
 */
async function subscribeViaTransport(
  channel: string,
  handler: (event: unknown) => void
): Promise<() => void> {
  try {
    const { transport } = await import("@/lib/tauri")
    if (typeof transport.subscribe !== "function") return () => undefined
    const unsubscribe = transport.subscribe<unknown>(channel, (payload) => handler(payload))
    return typeof unsubscribe === "function" ? unsubscribe : () => undefined
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
  if (!isTauri()) return subscribeViaTransport("workflow:resume", handler)
  try {
    const mod = await import("@tauri-apps/api/event")
    const stop = await mod.listen("workflow:resume", (e) => handler(e.payload))
    return () => safeUnlisten(stop)
  } catch {
    return () => undefined
  }
}
