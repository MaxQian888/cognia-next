/**
 * Plugin SDK helper for Platform Connector adapters (ADR-0009).
 *
 * Pure typesafety pass-through — wrapping a connector in `defineConnector()`
 * gives plugin authors autocomplete and a compile-time check that the shape
 * matches `PluginConnectorDef`. The `factory` names an exported function from
 * the plugin's `main` entrypoint that the connectors bridge resolves into a
 * `PlatformAdapter` and registers with the ConnectorBus.
 *
 * Usage:
 *   const telegram = defineConnector({
 *     type: "telegram",
 *     factory: "createTelegramAdapter",
 *     configSchema: { type: "object", properties: { token: { type: "string" } } },
 *     transportModes: ["polling", "webhook"],
 *     webhookVerification: {
 *       kind: "hmacSha256",
 *       secretKey: "signingSecret",
 *       signatureHeader: "X-Telegram-Signature",
 *     },
 *   })
 *
 * A connector that declares the `webhook` transport should declare
 * `webhookVerification` too. Rust carries hand-written verifiers only for the
 * four native webhook platforms, and every other kind fails closed without a
 * declaration, so the endpoint exists and refuses everything that reaches it.
 * The host executes the scheme rather than calling back into the plugin,
 * because verification has to happen BEFORE plugin code sees an
 * unauthenticated public request body.
 */

import type { PluginConnectorDef } from "@/types/plugin"

export function defineConnector(connector: PluginConnectorDef): PluginConnectorDef {
  return connector
}
