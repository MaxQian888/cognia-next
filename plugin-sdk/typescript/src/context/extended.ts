/**
 * Plugin SDK — extended context surface.
 *
 * The `native-anthropic-tool` capability contract names this file as the
 * SDK home for the `context.agent.register*` entry points plugins use
 * during `activate()` when they need dynamic-id registration. The base
 * `PluginContext` is defined in `@/types/plugin/plugin.ts`; this module
 * re-exports the agent + context types so plugin authors can rely on a
 * stable `plugin-sdk/typescript/src/context/extended.ts` import path.
 */

export type {
  PluginAgentAPI,
  PluginContext,
  PluginDefinition,
  PluginLogger,
  PluginManifest,
} from "@/types/plugin"
export type { PluginMcpServerPresetDef } from "@/types/plugin/plugin-mcp-preset"
export type { PluginNativeAnthropicToolDef } from "@/types/plugin/plugin-native-tool"
export type { PluginSkillDef } from "@/types/plugin/plugin-skill"
