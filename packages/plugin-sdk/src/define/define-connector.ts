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
 *   })
 */

import type { PluginConnectorDef } from "@/types/plugin"

export function defineConnector(connector: PluginConnectorDef): PluginConnectorDef {
  return connector
}
