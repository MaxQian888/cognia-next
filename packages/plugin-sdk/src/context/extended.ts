/**
 * Plugin SDK — extended context surface.
 *
 * The `native-anthropic-tool` capability contract names this file as the
 * SDK home for the `context.agent.register*` entry points plugins use
 * during `activate()` when they need dynamic-id registration. The base
 * context barrel remains the source of truth; this module mirrors it and
 * keeps the legacy agent-registration definition imports available from the
 * stable `@cognia/plugin-sdk/context/extended` import path.
 */

export type * from "./index"
export type { PluginDefinition, PluginManifest } from "@/types/plugin"
export type { PluginMcpServerPresetDef } from "@/types/plugin/plugin-mcp-preset"
export type { PluginNativeAnthropicToolDef } from "@/types/plugin/plugin-native-tool"
export type { PluginSkillDef } from "@/types/plugin/plugin-skill"
