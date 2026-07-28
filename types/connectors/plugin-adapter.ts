import type { PluginConnectorDef } from "@/types/plugin/plugin"
import type { PlatformAdapter } from "./adapter"

/** Stable host context supplied to a TypeScript connector contribution. */
export interface PluginAdapterContext {
  pluginId: string
  connectorDef: PluginConnectorDef
}

/** Shared connector factory contract used by both the host bridge and SDK. */
export type PluginAdapterFactory = (
  context: PluginAdapterContext
) => PlatformAdapter | Promise<PlatformAdapter>
