/** Public, author-safe surface for `@cognia/plugin-sdk`. */

export type * from "./manifest"
export type * from "./context"
export type * from "./hooks"
export type * from "./permissions"
export type * from "./extensions"
export type {
  BusEvent,
  EventFilter,
  EventSource,
  EventSubscription,
  PluginEventAPI,
} from "./events"
export { SystemEvents } from "./events"
export { CANONICAL_EXTENSION_POINTS } from "./extensions"

export {
  AUTHOR_CAPABILITY_CONTRACTS,
  CANONICAL_PLUGIN_CAPABILITIES,
  CANONICAL_PLUGIN_PERMISSIONS,
  CANONICAL_PLUGIN_TYPES,
  PLUGIN_CONTRACT_MINIMUM_HOST_VERSION,
  PLUGIN_CONTRACT_SCHEMA_VERSION,
  PLUGIN_MANIFEST_CONTRIBUTIONS,
  PLUGIN_PATH_FIELD_CONTRACTS,
  PLUGIN_RUNTIME_ENTRY_CONTRACTS,
} from "./contracts/catalog"

export { definePlugin } from "./manifest"
export { defineMcpServerPreset } from "./define/define-mcp-server-preset"
export { defineNativeAnthropicTool } from "./define/define-native-anthropic-tool"
export { defineSkill } from "./define/define-skill"
export { defineSubagent } from "./define/define-subagent"
export { defineAgentTeamTemplate } from "./define/define-agent-team-template"
export {
  defineCharacterPack,
  PLUGIN_CHARACTER_AVATAR_WEB_DATA_URL_SOFT_BYTES,
  PLUGIN_CHARACTER_PACK_SOFT_LIMIT,
} from "./define/define-character-pack"
export { defineWorkflowTemplate } from "./define/define-workflow-template"
export { defineAgentTool } from "./define/define-agent-tool"
export { defineTool } from "./define/define-tool"
export { defineGuardrail } from "./define/define-guardrail"
export { defineContextProvider } from "./define/define-context-provider"
export { defineContextPanel } from "./define/define-context-panel"
export { defineA2UIComponent } from "./define/define-a2ui-component"
export { defineA2UITemplate } from "./define/define-a2ui-template"
export { defineAiProvider } from "./define/define-ai-provider"
export { defineCliTool } from "./define/define-cli-tool"
export { defineCommand } from "./define/define-command"
export { defineLspServer } from "./define/define-lsp-server"
export { defineMode } from "./define/define-mode"
export { defineOcrProvider } from "./define/define-ocr-provider"
export { definePetAchievement } from "./define/define-pet-achievement"
export { definePetItem } from "./define/define-pet-item"
export { defineScheduledTask } from "./define/define-scheduled-task"
export { defineWorkspaceBackend } from "./define/define-workspace-backend"
export { defineMessageRenderer } from "./define/define-message-renderer"
export { defineDensityPreset } from "./define/define-density-preset"
export { defineChatMiddleware } from "./define/define-chat-middleware"
export { defineModalMount } from "./define/define-modal-mount"
export { defineTerminalCompletionProvider } from "./define/define-terminal-completion"
export { defineRoutingStrategy } from "./define/define-routing-strategy"
export { defineDeploymentFilter } from "./define/define-deployment-filter"
export { defineProtocolAdapter } from "./define/define-protocol-adapter"
export { defineToolRoute } from "./define/define-tool-route"
export { defineViewContainer } from "./define/define-view-container"
export { defineTreeDataProvider, defineView } from "./define/define-view"
export { defineWebview } from "./define/define-webview"
export { defineAuthProvider } from "./define/define-auth-provider"
export { defineUriHandler } from "./define/define-uri-handler"
export { defineTheme } from "./define/define-theme"
export { defineThemePack } from "./define/define-theme-pack"
export { defineFontContribution } from "./define/define-font-contribution"
export { defineWallpaper } from "./define/define-wallpaper"
export { defineConnector } from "./define/define-connector"
export { defineWorkflowNode } from "./define/define-workflow-node"
export { defineWorkflowTrigger } from "./define/define-workflow-trigger"
export { defineExporter } from "./define/define-exporter"
export { defineImporter } from "./define/define-importer"
export { defineConfiguration } from "./define/define-configuration"
export { defineQuickAction } from "./define/define-quick-action"
export { defineExternalAgentPreset } from "./define/define-external-agent-preset"
export { defineExternalAgentAdapter } from "./define/define-external-agent-adapter"
export { defineSessionImporter } from "./define/define-session-importer"
export { defineSharedMemoryAdapter } from "./define/define-shared-memory-adapter"
export { defineBalanceAdapter } from "./define/define-balance-adapter"
export { defineLimitsSource } from "./define/define-limits-source"
export { defineImRateSource } from "./define/define-im-rate-source"
export { defineCompactionStrategy } from "./define/define-compaction-strategy"
export { defineTrayItem } from "./define/define-tray-item"
