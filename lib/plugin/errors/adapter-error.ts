/**
 * Host-side sibling of `packages/plugin-sdk/src/errors/adapter-error.ts`.
 *
 * The SDK module owns the throwable shape (public author surface). This
 * module owns the *reporting* pipeline — turning an adapter error into a
 * user-visible event via `dispatchPluginError` (the pre-existing plugin
 * error bus in `./error-bus.ts`). This keeps DevTools + the Plugins
 * settings pane subscribed to ONE channel, matching Working Rule 1
 * (reuse — do not create a parallel event channel).
 *
 * The SDK-side class is re-exported here so host modules import the same
 * concrete symbol authors do, and `instanceof` checks stay consistent
 * across the boundary.
 */

import {
  isPluginAdapterError,
  PluginAdapterError,
  pluginAdapterError,
  type PluginAdapterErrorCode,
} from "@cognia/plugin-sdk"
import { dispatchPluginError, type PluginErrorSeverity } from "@/lib/plugin/error-bus"

export { isPluginAdapterError, PluginAdapterError, pluginAdapterError, type PluginAdapterErrorCode }

/**
 * Which codes are user-recoverable (the failure is transient or the user
 * can supply a value) vs. permanent (invalid manifest / policy denial).
 * Feeds `PluginErrorEventDetail.recoverable`, which the toast subscriber
 * uses to decide whether to render a "Retry" affordance.
 */
const RECOVERABLE_CODES = new Set<PluginAdapterErrorCode>([
  "DEPENDENCY_MISSING",
  "SECRET_MISSING",
  "TIMEOUT",
  "PROCESS_LIMIT",
])

const DEFAULT_SEVERITY: PluginErrorSeverity = "error"

export interface ReportAdapterErrorOptions {
  pluginId: string
  pluginName?: string
  severity?: PluginErrorSeverity
}

/**
 * Dispatch an adapter error through the shared plugin error bus. This is
 * the single sink used by the CLI executor, the process supervisor
 * (Phase 3), and the automation session (Phase 4). Bodies are never
 * logged here — the adapter caller must redact argv / secrets before
 * building the message (see `packages/redact` sentinels).
 */
export function reportAdapterError(
  error: PluginAdapterError,
  options: ReportAdapterErrorOptions
): void {
  dispatchPluginError({
    pluginId: options.pluginId,
    pluginName: options.pluginName,
    stage: "adapter",
    message: error.hint
      ? `${error.code}: ${error.message} (${error.hint})`
      : `${error.code}: ${error.message}`,
    severity: options.severity ?? DEFAULT_SEVERITY,
    recoverable: RECOVERABLE_CODES.has(error.code),
  })
}
