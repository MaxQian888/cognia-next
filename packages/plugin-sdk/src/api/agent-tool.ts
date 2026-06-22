/**
 * Plugin SDK — agent-tool authoring surface (Agent SDK).
 *
 * Re-exports the `defineAgentTool()` helper plugin authors use to declare a
 * typed agent tool (name + schema + handler) for the in-process agent SDK
 * runtime. A typesafe identity pass-through that narrows the inferred shape
 * to `PluginAgentToolInput`.
 *
 * Sources:
 *  - `lib/plugin/sdk/define-agent-tool.ts`
 *  - `types/plugin/plugin-agent-sdk.ts`
 */

export { defineAgentTool } from "@/lib/plugin/sdk/define-agent-tool"

export type { PluginAgentToolInput } from "@/types/plugin/plugin-agent-sdk"
