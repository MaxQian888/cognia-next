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
export { defineGuardrail } from "./define-guardrail"
export { defineContextProvider } from "./define-context-provider"
export { defineViewContainer } from "./define-view-container"
export { defineView, defineTreeDataProvider } from "./define-view"
export type { TreeDataProvider, PluginTreeNode, PluginViewProps } from "@/types/plugin/plugin-view"
export { defineWebview } from "./define-webview"
export type { PluginWebviewHandle, PluginWebviewMessage } from "@/types/plugin/plugin-webview"
export { defineAuthProvider } from "./define-auth-provider"
export { defineUriHandler } from "./define-uri-handler"
// Appearance contributions (ADR-0029 / ADR-0030).
export { defineTheme } from "./define-theme"
export { defineThemePack } from "./define-theme-pack"
export { defineFontContribution } from "./define-font-contribution"
export { defineWallpaper } from "./define-wallpaper"
// Platform Connectors (ADR-0009).
export { defineConnector } from "./define-connector"
// Visual-workflow extensions (ADR-0017).
export { defineWorkflowNode } from "./define-workflow-node"
export { defineWorkflowTrigger } from "./define-workflow-trigger"
// Custom exporters / importers.
export { defineExporter } from "./define-exporter"
export { defineImporter } from "./define-importer"
// Declarative configuration schema (VS Code contributes.configuration parity).
export { defineConfiguration } from "./define-configuration"
// Type-only overlay-registry capabilities (authoring-sugar pass-throughs).
export { defineQuickAction } from "./define-quick-action"
export { defineExternalAgentPreset } from "./define-external-agent-preset"
export { defineSharedMemoryAdapter } from "./define-shared-memory-adapter"
export { defineBalanceAdapter } from "./define-balance-adapter"
export { defineLimitsSource } from "./define-limits-source"
export { defineImRateSource } from "./define-im-rate-source"
export { defineCompactionStrategy } from "./define-compaction-strategy"
export { defineTrayItem } from "./define-tray-item"
export type { ParsedDeepLink } from "@/lib/plugin/uri/parse-deep-link"
export { runPkceAuthFlow } from "@/lib/plugin/auth/auth-pkce-flow"
export type { PkceFlowConfig, PkceTokenResult } from "@/lib/plugin/auth/auth-pkce-flow"
export { __makeSession } from "@/lib/plugin/auth/auth-provider-registry"
export type { AuthSession } from "@/lib/plugin/auth/auth-provider-registry"
// Agent SDK runtime helpers (re-exported for plugin-author ergonomics).
export { createPiiRedactionGate } from "@/lib/plugin/agent-sdk/pii-gate"
export { createPiiOutputGuardrail } from "@/lib/plugin/agent-sdk/guardrails"
