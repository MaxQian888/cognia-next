/**
 * Lands out-of-process plugin API calls on the agent-trace surface.
 *
 * `recordPluginApiAudit` has measured every `ctx.*` call — duration, outcome,
 * data classification — since the governed context was introduced, and nothing
 * consumed it. That was tolerable while every plugin ran in the renderer and a
 * `ctx.storage.get` was an ordinary function call. It stopped being tolerable
 * with ADR-0143: a Python plugin's call is an IPC round trip to another
 * process, and "what did the plugin ask for, how long did it take, did it
 * fail" had no answer anywhere in the product.
 *
 * Rides `/logs` → Traces rather than a new panel, mirroring the `hook_audit`
 * span in `lib/claude/adapter.ts` — same shape, same reasoning.
 *
 * **Only out-of-process runtimes are traced.** An in-renderer TypeScript
 * plugin's `ctx.*` call is a function call on the same stack the caller can
 * already see; emitting a span per call would bury the ones that matter under
 * traffic that never crossed a boundary. Denials are the exception: a refused
 * call is a diagnostic in any runtime, so those are always recorded.
 */

import { emitFinishedSpan } from "@cognia/agent-trace/emitter"

import {
  subscribePluginApiAudit,
  type PluginApiAuditEvent,
} from "@/lib/plugin/contracts/interface-catalog"

/** Vendor provider id for these spans (OTel permits non-well-known values). */
export const PLUGIN_API_SPAN_PROVIDER = "cognia.plugin-api"

/** Traces have no session here; mirrors `hook_audit`'s "hook-runtime". */
export const PLUGIN_API_SPAN_SESSION = "plugin-runtime"

/** Runtimes whose calls cross a process boundary and so earn a span. */
const OUT_OF_PROCESS_RUNTIMES = new Set(["python", "wasm", "vscode"])

/** Whether one audit event should become a span. Exported for the test. */
export function shouldTracePluginApiCall(event: PluginApiAuditEvent): boolean {
  if (event.outcome !== "allowed") return true
  return OUT_OF_PROCESS_RUNTIMES.has(event.runtime)
}

/** Build the span for one audit event. Exported so its shape is pinned. */
export function pluginApiAuditSpan(
  event: PluginApiAuditEvent,
  now: number
): Parameters<typeof emitFinishedSpan>[0] {
  const durationMs = Math.max(0, event.durationMs)
  const startTime = now - durationMs
  return {
    operationName: "execute_tool",
    providerName: PLUGIN_API_SPAN_PROVIDER,
    surface: "plugin",
    pluginId: event.pluginId,
    sessionId: PLUGIN_API_SPAN_SESSION,
    toolName: event.methodId,
    startTime,
    durationMs,
    status: event.outcome === "allowed" ? "ok" : "error",
    ...(event.outcome === "allowed"
      ? {}
      : {
          errorType: event.outcome === "denied" ? "plugin_api_denied" : "plugin_api_error",
          ...(event.errorCode ? { errorMessage: event.errorCode } : {}),
        }),
    events: [
      {
        name: "plugin.api.audit",
        at: startTime,
        attributes: {
          runtime: event.runtime,
          outcome: event.outcome,
          dataClassification: event.dataClassification,
        },
      },
    ],
  }
}

let unsubscribe: (() => void) | null = null

/**
 * Start forwarding plugin API audits to the trace surface. Idempotent — the
 * plugin manager may initialize more than once in a session (and does in
 * tests), and a second subscription would double every span.
 */
export function startPluginApiSpanBridge(now: () => number = Date.now): () => void {
  if (unsubscribe) return unsubscribe
  unsubscribe = subscribePluginApiAudit((event) => {
    if (!shouldTracePluginApiCall(event)) return
    try {
      emitFinishedSpan(pluginApiAuditSpan(event, now()))
    } catch {
      // Telemetry is never allowed to break the call it describes.
    }
  })
  return unsubscribe
}

/** Stop forwarding. Safe to call when not started. */
export function stopPluginApiSpanBridge(): void {
  unsubscribe?.()
  unsubscribe = null
}
