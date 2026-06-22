/**
 * Plugin SDK — agent-tool authoring surface (Agent SDK).
 *
 * Re-exports the `defineAgentTool()` helper plugin authors use to declare a
 * typed agent tool (name + schema + handler) for the in-process agent SDK
 * runtime. A typesafe identity pass-through that narrows the inferred shape
 * to `PluginAgentToolInput`.
 *
 * Sources:
 *  - `packages/plugin-sdk/src/define/define-agent-tool.ts`
 *  - `types/plugin/plugin-agent-sdk.ts`
 */

export { defineAgentTool } from "../define/define-agent-tool"

export type { PluginAgentToolInput } from "@/types/plugin/plugin-agent-sdk"
