/**
 * Brain-side counter bumps for the companion's Lark observability series
 * (plan 2026-07-24 P6). Fire-and-forget by contract: metrics must never
 * block or fail a product path, so the RPC result is ignored and every
 * failure (desktop transport without the RPC arm, companion down, name
 * rejected) is swallowed. Security-relevant events additionally write
 * durable audit rows at their call sites — metrics are the aggregate view,
 * audits are the record.
 *
 * The name allowlist mirrors `companion_api/metrics.rs:record_lark_counter`
 * — the Rust side is authoritative and also rejects unknown names, this
 * local copy just avoids pointless round-trips.
 */

import { transport } from "@/lib/tauri"

export const CONNECTOR_METRIC_NAMES = [
  "lark_sso_logins_total",
  "lark_sso_failures_total",
  "lark_entry_resolve_ok_total",
  "lark_entry_resolve_denied_total",
  "lark_principal_unbound_total",
  "lark_callback_auth_denied_total",
  "lark_chat_tab_sync_failures_total",
  "lark_native_slash_total",
  "lark_message_imports_total",
  "lark_message_import_denied_total",
] as const

export type ConnectorMetricName = (typeof CONNECTOR_METRIC_NAMES)[number]

const ALLOWED: ReadonlySet<string> = new Set(CONNECTOR_METRIC_NAMES)

export interface RecordConnectorMetricDependencies {
  call: <T>(name: string, args?: Record<string, unknown>) => Promise<T>
}

/** Bump one allowlisted counter. Unknown names are a silent no-op. */
export function recordConnectorMetric(
  name: string,
  overrides: Partial<RecordConnectorMetricDependencies> = {}
): void {
  if (!ALLOWED.has(name)) return
  const call = overrides.call ?? transport.call
  void Promise.resolve()
    .then(() => call("lark_metrics_record", { name }))
    .catch(() => undefined)
}
