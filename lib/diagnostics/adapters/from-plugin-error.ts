/**
 * `PluginErrorEventDetail` → diagnostic inputs.
 *
 * `lib/plugin/error-bus.ts` is the healthiest error path in the repo: typed
 * stages, an explicit `recoverable` flag, unconditional structured logging, and
 * a root-mounted toaster that has always been subscribed. Nothing about it
 * needs changing.
 *
 * This adapter exists so a plugin failure can *also* be expressed in the shared
 * vocabulary — which is what lets a permanent one (`recoverable: false`) earn a
 * durable notification-center record instead of a toast the user may never see.
 */

import type { DiagnosticMeta, DiagnosticSeverity } from "@cognia/diagnostics"
import type { PluginErrorEventDetail } from "@/lib/plugin/error-bus"

export interface PluginErrorDiagnosis {
  code: "unknown"
  severity: DiagnosticSeverity
  /** From the bus — the plugin pipeline knows whether a retry can help. */
  retryable: boolean
  /** A permanent plugin failure stays true until the plugin itself ships a fix. */
  persistent: boolean
  message: string
  meta: DiagnosticMeta
}

/**
 * Plugin failures are deliberately mapped to `unknown` rather than to a
 * more specific code. The bus classifies by *pipeline stage* (install, load,
 * activation…), not by cause, so the stage says where it broke, never why —
 * inventing e.g. `providerMisconfigured` from `stage: "config"` would be a
 * guess. The stage is preserved in `meta.extra` where it belongs.
 */
export function diagnosePluginError(detail: PluginErrorEventDetail): PluginErrorDiagnosis {
  return {
    code: "unknown",
    severity: detail.severity === "warning" ? "warning" : "error",
    retryable: detail.recoverable,
    persistent: !detail.recoverable,
    message: detail.message,
    meta: {
      pluginId: detail.pluginId,
      extra: {
        stage: detail.stage,
        ...(detail.pluginName ? { pluginName: detail.pluginName } : {}),
      },
    },
  }
}
