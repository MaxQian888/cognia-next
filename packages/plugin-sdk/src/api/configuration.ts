/**
 * Plugin SDK - `configuration` capability surface.
 *
 * Re-exports the declarative configuration schema helper and runtime config
 * API contracts. The live `createConfigAPI` constructor depends on host plugin
 * stores, so plugin authors should access configuration through `ctx.config`
 * / `ctx.configuration` rather than constructing it directly.
 */

export { defineConfiguration } from "../define/define-configuration"

export type { PluginConfigAPI } from "@/types/plugin/plugin"
export type { PluginConfigProperty, PluginConfigSchema } from "@/types/plugin"
