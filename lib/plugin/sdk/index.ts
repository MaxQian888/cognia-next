/**
 * Plugin SDK helpers — in-tree typesafety sugar for plugin authors.
 *
 * Each `defineXxx()` is a one-line pass-through that narrows the inferred
 * type to the matching capability def. Use these when constructing
 * manifest entries inline so TypeScript can catch shape mistakes at
 * authoring time. The host runtime does not consume these helpers — the
 * plugin manager reads the manifest fields directly.
 *
 * Future home: when a separate `plugin-sdk/typescript/` package is
 * spun up, these helpers will move there. The contracts in
 * `lib/plugin/contracts/plugin-capabilities.ts` already point to the
 * future paths; this in-tree directory is the M1 bootstrap.
 */

export { defineMcpServerPreset } from "./define-mcp-server-preset"
export { defineNativeAnthropicTool } from "./define-native-anthropic-tool"
export { defineSkill } from "./define-skill"
export { defineSubagent } from "./define-subagent"
export { defineAgentTeamTemplate } from "./define-agent-team-template"
export { defineCharacterPack } from "./define-character-pack"
export { defineWorkflowTemplate } from "./define-workflow-template"
export { defineAgentTool } from "./define-agent-tool"
// Agent SDK runtime helper (re-exported for plugin-author ergonomics).
export { createPiiRedactionGate } from "@/lib/plugin/agent-sdk/pii-gate"
