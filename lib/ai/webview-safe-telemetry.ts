/**
 * The `telemetry` option for every renderer `streamText` call.
 *
 * With a telemetry dispatcher, `streamText` hands the dispatcher a tracing
 * `completion` promise it derives from the result's usage
 * (`_totalUsage.promise.then(...)`). On a non-Node runtime (the browser and the
 * Capacitor webview) ai@7's `openTelemetryChannelSpanContext` returns before it
 * ever observes that promise; only its Node branch attaches a catch. So a
 * failed stream (NoOutputGeneratedError) or a stopped one (the abort reason)
 * rejects an orphan no caller can reach, and it surfaces as an unhandled
 * rejection. Still unfixed upstream as of ai@7.0.113.
 *
 * `isEnabled: false` makes the SDK build an empty dispatcher, so no completion
 * promise is derived at all. That is merged in only where telemetry has nowhere
 * to go, so an opt-out never costs a real integration:
 *
 * - On Node (the CLI, Jest) the value passes through untouched: the SDK swallows
 *   the promise itself there, and a `diagnostics_channel` subscriber may be
 *   listening for spans.
 * - A caller that set `isEnabled` itself or passed its own `integrations` keeps
 *   its value as-is. In the webview such a call still leaks on failure, since
 *   the SDK offers no seam to observe that promise. No call site does this
 *   today, and the caller owns that trade.
 * - A globally registered integration (`registerTelemetry`) keeps telemetry on.
 *   The renderer registers none today. The sidecar's Langfuse integration lives
 *   in its own Node process.
 *
 * Otherwise the caller's remaining fields (`functionId`, `recordInputs`, ...)
 * are kept and `isEnabled: false` is merged over them.
 */

import type { TelemetryOptions } from "ai"

/** The same probe the SDK's `isNodeRuntime()` uses to pick its branch. */
function isNodeRuntime(): boolean {
  return typeof process !== "undefined" && process.release?.name === "node"
}

export function webviewSafeTelemetry(telemetry?: TelemetryOptions): TelemetryOptions | undefined {
  if (isNodeRuntime()) return telemetry
  if (telemetry?.isEnabled !== undefined || telemetry?.integrations != null) return telemetry
  if ((globalThis.AI_SDK_TELEMETRY_INTEGRATIONS?.length ?? 0) > 0) return telemetry
  return { ...telemetry, isEnabled: false }
}
