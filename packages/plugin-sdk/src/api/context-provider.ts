/** Portable authoring surface for context providers registered through `ctx.agent.context`. */

export { defineContextProvider } from "../define/define-context-provider"

export type {
  PluginContextProvider,
  PluginContextProviderDef,
  PluginContextProviderFactoryContext,
} from "@/types/plugin/plugin-context-provider"

export type {
  ContextProvidersBridgeError,
  ContextProvidersBridgeOptions,
  ContextProvidersBridgeResult,
} from "@/lib/plugin/bridge/context-providers-bridge"
