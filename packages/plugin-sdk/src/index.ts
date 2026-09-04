/** Public, author-safe surface for `@cognia/plugin-sdk`. */

export type * from "./manifest"
export type * from "./context"
export * from "./ide"
export type * from "./hooks"
export type * from "./permissions"
export type * from "./extensions"
export type {
  CreateTemplateDraftInput,
  PluginTemplatePackageContribution,
  TemplateCatalogQuery,
  TemplateDefinitionDraft,
  TemplateDefinitionEnvelope,
  TemplateDependency,
  TemplateDomain,
  TemplateInputSpec,
  TemplateInstantiationResult,
  TemplatePackageManifest,
  TemplatePreflightPlan,
  WorkflowNodeGroupDefinition,
  WorkflowNodeGroupEdge,
  WorkflowNodeGroupNode,
  WorkflowNodeGroupPayload,
} from "./templates"
export type * from "./api/integration"
export type { PluginModalProps } from "./api/modal-mount"
export type { PluginViewProps, TreeDataProvider } from "./api/view"
export type {
  BusEvent,
  EventFilter,
  EventSource,
  EventSubscription,
  PluginEventAPI,
} from "./events"
export { SystemEvents } from "./events"
export { CANONICAL_EXTENSION_POINTS } from "./extensions"

/**
 * Author-callable host tools. The names + narrowing helpers are runtime values
 * (the types ride along on the `./context` re-export above), so a plugin can
 * validate a `ctx.agent.invokeTool("web_search" | "web_fetch", …)` result
 * without hand-rolling shape checks.
 */
export {
  PLUGIN_AUTHOR_CALLABLE_HOST_TOOLS,
  isAuthorCallableHostTool,
  isPluginHostToolFailure,
  isPluginWebFetchSuccess,
  isPluginWebSearchSuccess,
  pluginWebFetchText,
} from "@/types/plugin/plugin-host-tools"

/**
 * The host's prompt-injection framing for third-party text. Re-exported (not
 * re-declared) so a plugin that composes fetched pages or search snippets into
 * a model prompt frames them with the SAME banner the host uses — two copies
 * would drift, and a drifted banner is one the model has not been trained by
 * the rest of the app to distrust.
 */
export {
  UNTRUSTED_CONTENT_NOTICE,
  unwrapUntrustedContent,
  wrapUntrustedContent,
} from "@/lib/web/untrusted-content"

/**
 * The reasoning-tier vocabulary, re-exported (not re-declared) for the same
 * reason the untrusted-content banner above is.
 *
 * `THINKING_LEVELS` is pinned to the union persisted on `ChatSession`, so a new
 * tier fails typecheck if the two drift. A plugin that hand-copied the list
 * would just keep offering the old one, and a plugin that hand-wrote the
 * `{ effort, thinkingLevel }` pair would eventually disagree with itself, which
 * is precisely what `thinkingLevelPatch` exists to prevent. Any plugin that
 * reads or writes a session's tier composes these.
 *
 * The narrowing half ships with the vocabulary for the same reason: the full
 * ladder is what a session MAY hold, not what a given provider/model can carry.
 * Publishing `THINKING_LEVELS` without `availableThinkingLevels` /
 * `clampThinkingLevel` / `visibleThinkingLevels` would leave every author able
 * to offer `max` on a surface that folds it into `high`, naming a depth the
 * request never carries.
 */
export {
  EFFORT_SLIDER_LEVELS,
  SDK_EFFORT_LEVELS,
  THINKING_LEVELS,
  availableThinkingLevels,
  clampThinkingLevel,
  externalAgentThinkingLevels,
  isUltracodeLevel,
  resolveThinkingLevel,
  thinkingLevelPatch,
  thinkingLevelToEffort,
  visibleThinkingLevels,
} from "@/lib/ai/thinking-level"
export type { Effort, EffortTier, ThinkingLevel } from "@/lib/ai/thinking-level"

/**
 * The pure half of the composed answer, published alongside the vocabulary
 * above because the vocabulary alone is a trap.
 *
 * The full ladder is what a session MAY hold. Which tiers to OFFER depends on
 * four things a session row does not carry: the runtime lane executing the turn,
 * the app-level model/provider defaults behind an unpinned session, whether the
 * model reasons at all, and the user's hidden-tier preference. `resolveEffortSurface`
 * takes all four as values, so it decides nothing on its own and reads nothing.
 *
 * The half that GATHERS those four from the host's stores lives at
 * `@cognia/plugin-sdk/api/effort-surface`, with the subscription that says when
 * they change. It is a subpath and not this barrel on purpose: the root
 * publishes types and pure functions only, so importing a type from here never
 * pulls the settings and agent-runtime stores into a plugin's module graph.
 */
export { resolveEffortSurface } from "@/lib/ai/effort-surface"
export type { EffortSurface, EffortSurfaceInput } from "@/lib/ai/effort-surface"

export {
  AUTHOR_CAPABILITY_CONTRACTS,
  CANONICAL_PLUGIN_CAPABILITIES,
  CANONICAL_PLUGIN_ERROR_CODES,
  CANONICAL_PLUGIN_PERMISSIONS,
  CANONICAL_PLUGIN_TYPES,
  PLUGIN_CONTRACT_MINIMUM_HOST_VERSION,
  PLUGIN_CONTRACT_SCHEMA_VERSION,
  PLUGIN_API_NAMESPACE_CONTRACTS,
  PLUGIN_CONTRACT_VERSION,
  PLUGIN_GATEWAY_CLIENT_VERSION,
  PLUGIN_MINIMUM_GATEWAY_CLIENT_VERSION,
  PLUGIN_MINIMUM_SDK_VERSION,
  PLUGIN_PROTOCOL_VERSION,
  PLUGIN_SDK_VERSION,
  PLUGIN_MANIFEST_CONTRIBUTIONS,
  PLUGIN_PATH_FIELD_CONTRACTS,
  PLUGIN_RUNTIME_ENTRY_CONTRACTS,
  PLUGIN_SERVICE_CONTRACTS,
  type CanonicalPluginErrorCode,
  type PluginApiMethodContract,
  type PluginApiNamespaceContract,
  type PluginServiceContract,
} from "./contracts/catalog"
export {
  PluginAdapterError,
  pluginAdapterError,
  isPluginAdapterError,
} from "./errors/adapter-error"
export type { PluginAdapterErrorCode, PluginAdapterErrorPayload } from "./errors/adapter-error"

export { definePlugin } from "./define/define-plugin"
export { defineMcpServerPreset } from "./define/define-mcp-server-preset"
export { defineNativeAnthropicTool } from "./define/define-native-anthropic-tool"
export { defineSkill } from "./define/define-skill"
export { defineSubagent } from "./define/define-subagent"
export type { PluginSubagentInput, PluginSubagentToolReference } from "./define/define-subagent"
export { defineAgentTeamTemplate } from "./define/define-agent-team-template"
export {
  defineCharacterPack,
  PLUGIN_CHARACTER_AVATAR_WEB_DATA_URL_SOFT_BYTES,
  PLUGIN_CHARACTER_PACK_SOFT_LIMIT,
} from "./define/define-character-pack"
export { defineWorkflowTemplate } from "./define/define-workflow-template"
export {
  defineTemplate,
  defineTemplatePackage,
  defineWorkflowNodeGroup,
  defineWorkflowNodeGroups,
  verifyTemplateDefinitionHash,
  WORKFLOW_NODE_GROUP_PAYLOAD_KIND,
} from "./templates"
export { defineAgentTool } from "./define/define-agent-tool"
export { defineTool } from "./define/define-tool"
export { definePluginTool } from "./define/define-plugin-tool"
export { defineGuardrail } from "./define/define-guardrail"
export { defineContextProvider } from "./define/define-context-provider"
export { defineContextPanel } from "./define/define-context-panel"
export { defineExtension } from "./define/define-extension"
/**
 * `ctx.editor` has no manifest field to define — it is a pure runtime API — so
 * only its types surface here. The full contract lives in `./api/editor`.
 */
export type {
  ActiveEditorContext,
  ActiveEditorDiagnostic,
  PluginActiveEditorContext,
  PluginEditorAPI,
  PluginEditorOpenOptions,
  PluginEditorOpenResult,
} from "./api/editor"
export { defineA2UIComponent } from "./define/define-a2ui-component"
export { defineA2UITemplate } from "./define/define-a2ui-template"
export { defineAiProvider } from "./define/define-ai-provider"
export { defineCliTool } from "./define/define-cli-tool"
export { defineCommand } from "./define/define-command"
export { defineLspServer } from "./define/define-lsp-server"
export { defineBot, defineBotHandler } from "./define/define-bot"
export type {
  PluginBotDef,
  PluginBotExecutor,
  PluginBotTriggerDef,
  PluginBotTriggerKind,
  PluginBotEventSource,
  PluginBotCredentialSlot,
  PluginBotRequirementsV1,
  PluginBotCompositionRequestV1,
  PluginBotPolicyV1,
  PluginWorkflowBotDef,
  PluginSquadBotDef,
  PluginAgentTurnBotDef,
  PluginHandlerBotDef,
} from "@/types/plugin/plugin-bot"
export { PLUGIN_BOT_EXECUTORS, PLUGIN_BOT_TRIGGER_KINDS } from "@/types/plugin/plugin-bot"
export type {
  BotEventEnvelopeV1,
  BotEventActor,
  BotEventResource,
  BotEventProvenanceV1,
} from "@/types/bot/event"
export type {
  BotHandlerV1,
  BotHandlerResultV1,
  BotRunContextV1,
  BotRunSnapshotV1,
  BotStepApiV1,
  BotApprovalRequestV1,
  BotApprovalDecisionV1,
  BotWaitForEventInput,
  BotProgressUpdateV1,
  BotLogLevel,
} from "@/types/bot/run"
export { defineMode } from "./define/define-mode"
export { defineOcrProvider } from "./define/define-ocr-provider"
export { definePetAchievement } from "./define/define-pet-achievement"
export { definePetItem } from "./define/define-pet-item"
export { defineScheduledTask } from "./define/define-scheduled-task"
export { defineWorkspaceBackend } from "./define/define-workspace-backend"
export { defineMessageRenderer } from "./define/define-message-renderer"
export { defineToolRenderer } from "./define/define-tool-renderer"
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
export { defineIntegration } from "./define/define-integration"
export { defineWorkflowNode } from "./define/define-workflow-node"
export { defineWorkflowTrigger } from "./define/define-workflow-trigger"
export { defineExporter } from "./define/define-exporter"
export { defineImporter } from "./define/define-importer"
export { defineChatImporter } from "./define/define-chat-importer"
export { defineConfiguration } from "./define/define-configuration"
export { defineQuickAction } from "./define/define-quick-action"
export { defineExternalAgentPreset } from "./define/define-external-agent-preset"
export { defineExternalAgentAdapter } from "./define/define-external-agent-adapter"
export { defineSessionImporter } from "./define/define-session-importer"
export { defineSharedMemoryAdapter } from "./define/define-shared-memory-adapter"
export { defineBalanceAdapter } from "./define/define-balance-adapter"
export { defineLimitsSource } from "./define/define-limits-source"
export { defineProviderOperationAdapter } from "./define/define-provider-operation-adapter"
export { defineImRateSource } from "./define/define-im-rate-source"
export { defineCompactionStrategy } from "./define/define-compaction-strategy"
export { defineTrayItem } from "./define/define-tray-item"

// =============================================================================
// Domain vocabularies. A plugin implementing one of these capabilities types
// against the host's own shapes — a private copy is a copy that drifts.
//
// Only TYPES and pure helpers live here. The registries that make a
// contribution dynamic are deliberately absent from this barrel (see
// `index.test.ts`): each one is published as `@cognia/plugin-sdk/api/<capability>`
// so importing a registry is a decision an author writes down, not something
// that arrives with `import { definePlugin }`.
// =============================================================================

/** Character packs — the pack/character shapes and the portable file format. */
export type {
  CharacterPackFileSchemaVersion,
  LocalCharacterPackFile,
  LocalCharacterPackSignature,
  PluginCharacterDef,
  PluginCharacterPackWarning,
} from "./api/character-pack"
export {
  CHARACTER_PACK_FILE_SCHEMA_VERSION,
  parseLocalPackFile,
  serializeLocalPackFile,
  SUPPORTED_CHARACTER_PACK_SCHEMA_VERSIONS,
} from "./api/character-pack"

export type { PluginSkillSource } from "./api/skill"

export type {
  PluginWorkflowTemplateEdge,
  PluginWorkflowTemplateNode,
} from "./api/workflow-template"

export type { SharedMemoryAdapterChangeSet, SharedMemoryEntry } from "./api/shared-memory-adapter"

export type { BalanceQuery, BalanceSnapshot } from "./api/balance-adapter"

export type {
  ContextProvidersBridgeError,
  ContextProvidersBridgeOptions,
  ContextProvidersBridgeResult,
  PluginContextProviderFactoryContext,
} from "./api/context-provider"

/**
 * External agents. `BaseProtocolAdapter` is the abstract class an adapter
 * extends — subclassing it is what gets a plugin adapter the host's usage
 * folding and turn accounting instead of a private reimplementation.
 */
export { BaseProtocolAdapter, foldUsageUpdate, mergeTurnUsage } from "./api/external-agent-adapter"
export {
  getExternalAgentExecutionBlock,
  getExternalAgentExecutionBlockReason,
  isSupportedExternalAgentProtocol,
  SUPPORTED_EXTERNAL_AGENT_PROTOCOLS,
} from "./api/external-agent-adapter"
export type {
  AcpPermissionResponse,
  ExternalAgentConfig,
  ExternalAgentEvent,
  ExternalAgentExecutionBlockAssessment,
  ExternalAgentExecutionOptions,
  ExternalAgentMessage,
  ExternalAgentMessageDeltaEvent,
  ExternalAgentProtocol,
  ExternalAgentSession,
  ExternalAgentTransport,
  PluginProtocolAdapterMetadata,
  ProtocolAdapter,
  ProtocolAdapterFactory,
  ProtocolAdapterRegistryChange,
  SessionCreateOptions,
  SessionListOptions,
} from "./api/external-agent-adapter"
export type { ExternalAgentPresetConfig, ExternalAgentPresetId } from "./api/external-agent-preset"

/** Slash commands — the definition shape; the registry is on the subpath. */
export type {
  RegisterSlashCommandResult,
  SlashCommandContext,
  SlashCommandDefinition,
  SlashCommandHandler,
  SlashCommandResult,
} from "./api/slash-command"

/** Result rendering — a tool-result card, and a custom message-part renderer. */
export type { ToolResultRendererEntry, ToolResultRendererProps } from "./api/tool-renderer"
export type { MessagePartRendererEntry, MessagePartRendererProps } from "./api/message-renderer"

/** Context workbench — panel contributions and the resources they read. */
export { CONTEXT_RESOURCE_READ_PERMISSIONS } from "./api/context-panel"
export type {
  CanonicalContextActivity,
  CogniaContextPanelWebviewApi,
  ContextActivity,
  ContextCapability,
  ContextPanelMode,
  ContextPanelRegistry,
  ContextPanelRenderProps,
  ContextPanelRetention,
  ContextResource,
  ContextResourceKind,
  ContextWorkbenchMode,
  PluginContextPanelDef,
  PluginContextPanelIcon,
  PluginContextPanelRegistration,
  PluginContextPanelRenderer,
  PluginModuleContextPanelDef,
  PluginWebviewContextPanelDef,
} from "./api/context-panel"

/** Artifacts — the row `ctx.artifacts` stores and renders. */
export type { Artifact, ArtifactLanguage } from "./api/canvas"

/** Visual workflows — the graph a contributed node or trigger runs inside. */
export type {
  PluginNodeDef,
  PluginNodeExecuteFn,
  PluginTriggerDef,
  PluginTriggerHandle,
  PluginTriggerLogger,
  PluginTriggerStartContext,
  StepExecutionContext,
  StepExecutionResult,
  TriggerEvent,
  VisualWorkflow,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeData,
  WorkflowNodeKind,
  WorkflowTriggeredFrom,
} from "./api/workflow"

/** Scheduled tasks — the task/trigger/execution rows a plugin reads and writes. */
export { DEFAULT_PERMISSION_POLICY } from "./api/scheduled-task"
export type {
  CreateScheduledTaskInput,
  ScheduledTask,
  ScheduledTaskStatus,
  ScheduledTaskType,
  SchedulerPermissionPolicy,
  TaskExecution,
  TaskExecutionStatus,
  TaskExecutionTriggerSource,
  TaskTrigger,
  TaskTriggerType,
} from "./api/scheduled-task"

/**
 * Declarative CLI tools — the argv/cwd template engine. Pure functions, so a
 * plugin can preview or dry-run the exact command the executor would spawn.
 * The executor itself (`executeCliTool`) stays on `./api/cli-tool`.
 */
export { buildArgv, CliTemplateError, parseOutput, resolveCwd } from "./api/cli-tool"
export type {
  CwdContext,
  PluginCliArgvToken,
  PluginCliBinaryRef,
  PluginCliCwdPolicy,
  PluginCliOutputParse,
} from "./api/cli-tool"

/**
 * OCR provider contracts and pure result/cache helpers. Host extraction is
 * governed through `ctx.ocr`.
 */
export {
  buildOcrResultPart,
  createNullOcrCache,
  createNullOcrPageCache,
  DEFAULT_OCR_SETTINGS,
  OcrError,
  parseOcrArgs,
} from "./api/ocr-provider"
export type {
  CacheLookupKey,
  CacheWriteInput,
  OcrBlock,
  OcrBlockKind,
  OcrCostEstimate,
  OcrCredentials,
  OcrInput,
  OcrOutputFormat,
  OcrPage,
  OcrPageCache,
  OcrProvider,
  OcrProviderCategory,
  OcrProviderConfig,
  OcrProviderContext,
  OcrProviderShellSupport,
  OcrResultPart,
  OcrResult,
  OcrResultCache,
  OcrSource,
  OcrSourceRef,
  PageCacheKey,
  UserOcrSettings,
} from "./api/ocr-provider"

/** Desktop automation — the locator/action vocabulary; the client is on the subpath. */
export type {
  ActionRequest,
  ActionResult,
  AppLocator,
  AutomationSurface,
  CallContext,
  ElementHandle,
  ExpandedElements,
  GetAppStateOptions,
  Locator,
  PluginComputerUseOrigin,
  ResolvedApplication,
  UiStateRevision,
  UiTreeNode,
  UiaEventPayload,
} from "./api/automation"

/** Install-time validation is intentionally isolated on `@cognia/plugin-sdk/manifest`. */

/**
 * Cooperative cancellation. A plugin tool typically holds two signals — the
 * one the host hands it for the turn, and one of its own for an internal
 * timeout — and needs a single signal that fires when either does. Doing this
 * by hand leaks listeners; `combineAbortSignals` returns the merged signal
 * plus the `cleanup()` that detaches them, and answers `undefined` when there
 * is nothing to combine.
 */
export { combineAbortSignals } from "./runtime/abort"

/**
 * Hand the user a file. A plugin that exports a report, a transcript or a
 * SARIF log needs the same object-URL dance every host export does — including
 * the revoke, which is the part hand-rolled copies forget.
 */
export { downloadBlob } from "./runtime/download"
