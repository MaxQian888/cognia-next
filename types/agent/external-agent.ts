/**
 * External Agent Type Definitions
 * Defines types for integrating external agents via ACP (Agent Client Protocol) and other protocols
 *
 * @see https://github.com/anthropics/agent-client-protocol
 * @see https://github.com/zed-industries/claude-code-acp
 */

// ============================================================================
// Protocol Types
// ============================================================================

/**
 * Supported external agent protocols
 */
export type ExternalAgentProtocol =
  | "acp" // Agent Client Protocol (Claude Code, etc.)
  | "codex-app-server" // OpenAI Codex native app-server JSON-RPC (thread/turn/item)
  | "opencode" // OpenCode SDK/server protocol
  | "opencode-v2" // OpenCode V2 local-service preview protocol
  | "a2a" // Agent-to-Agent Protocol (Google)
  | "http" // HTTP/REST API
  | "websocket" // WebSocket
  | "custom" // Custom protocol via plugin

/**
 * External agent transport mechanism
 */
export type ExternalAgentTransport =
  | "stdio" // Standard input/output (local process)
  | "http" // HTTP REST
  | "websocket" // WebSocket connection
  | "sse" // Server-Sent Events

/**
 * Canonical runtime branch/block reason codes for external-agent routing and diagnostics.
 */
export type ExternalAgentBranchReasonCode =
  | "ok"
  | "agent_not_found"
  | "configuration_missing"
  | "agent_disabled"
  | "protocol_unsupported"
  | "transport_blocked"
  | "ecosystem_prerequisite_missing"
  | "ecosystem_documented_only"
  | "initialization_failed"
  | "health_check_failed"
  | "external_unavailable"
  | "extension_unknown"
  | "extension_unsupported"
  | "session_resolution_failed"
  | "permission_denied"
  | "execution_failed"
  | "strict_failure"
  | "fallback_to_builtin"

/**
 * Canonical branch outcome for external-agent orchestration.
 */
export type ExternalAgentBranchOutcome =
  "external" | "fallback" | "strict_failure" | "builtin" | "blocked"

/**
 * Lifecycle completeness stages used by manager/store/UI diagnostics.
 */
export type ExternalAgentLifecycleCompletenessStage =
  "config" | "connect" | "session_extensions" | "execution" | "fallback" | "recovery"

/**
 * Canonical execution eligibility state.
 */
export type ExternalAgentExecutionEligibility = "eligible" | "blocked"

/**
 * Support tier for a product-level external-agent ecosystem surface.
 */
export type ExternalAgentEcosystemSupportTier = "executable" | "guided" | "documented-only"

/**
 * Execution mode for a product-level external-agent ecosystem surface.
 */
export type ExternalAgentEcosystemExecutionMode = "direct" | "guided" | "external"

/**
 * Status of an individual ecosystem prerequisite.
 */
export type ExternalAgentEcosystemPrerequisiteState =
  "satisfied" | "missing" | "unknown" | "not-applicable"

/**
 * Aggregated prerequisite status projected for UI/runtime consumers.
 */
export type ExternalAgentEcosystemPrerequisiteStatus =
  "ready" | "action-required" | "unknown" | "not-applicable"

export interface ExternalAgentEcosystemPrerequisite {
  id: string
  label: string
  status: ExternalAgentEcosystemPrerequisiteState
  detail?: string
}

/**
 * Ecosystem-aware readiness facts projected from adapter/surface metadata.
 */
export interface ExternalAgentEcosystemReadinessSnapshot {
  adapterId?: string
  adapterName?: string
  surfaceId?: string
  surfaceName?: string
  supportTier?: ExternalAgentEcosystemSupportTier
  executionMode?: ExternalAgentEcosystemExecutionMode
  docsUrl?: string
  limitationNote?: string
  prerequisiteStatus?: ExternalAgentEcosystemPrerequisiteStatus
  prerequisites?: ExternalAgentEcosystemPrerequisite[]
  recommendedActions?: ExternalAgentRecommendedAction[]
}

/**
 * One line of "what to do about it" under an agent's readiness panel.
 *
 * Two shapes, because this array is persisted. Entries this app generates are
 * `{ id }` references into `externalAgent.manager.diagnostics.recommendedAction.*`
 * and are rendered in the reader's language; a bare string is either a value
 * persisted before that existed or prose supplied by a third-party preset,
 * and is rendered as-is because there is no key to look up.
 *
 * Mirrors how `recoveryHints` already carries key ids rather than prose — see
 * `resolveRecoveryHints` in `canonical-contract.ts`.
 */
export type ExternalAgentRecommendedAction =
  | string
  | {
      /** Key under `externalAgent.manager.diagnostics.recommendedAction`. */
      id: string
      /** ICU interpolation values for that message. */
      params?: Record<string, string>
    }

/**
 * Correlation metadata shared across manager/hook/router diagnostics.
 */
export interface ExternalAgentCorrelationMetadata {
  sessionId?: string
  turnId?: string
  traceId?: string
  source?: "manager" | "hook" | "router"
  observedAt: Date
}

export interface ExternalAgentLastRunSnapshot {
  terminalOutcome: "ok" | "error"
  branchReasonCode: ExternalAgentBranchReasonCode
  branchOutcome: ExternalAgentBranchOutcome
  timestamp: Date
  linkedSessionId?: string
  linkedTraceId?: string
  diagnosticText?: string
}

/**
 * Capability snapshot projected as canonical runtime facts.
 */
export interface ExternalAgentCapabilitySnapshot {
  protocol: ExternalAgentProtocol
  authRequired?: boolean
  authMethods?: string[]
  hasAgentCapabilities?: boolean
  sessionExtensions: ExternalAgentSessionExtensionSupport
}

/**
 * Benchmark gap grades for external-agent adaptation.
 */
export type ExternalAgentBenchmarkGapGrade = "blocking" | "major" | "minor"

/**
 * Adaptation status for benchmark capabilities.
 */
export type ExternalAgentBenchmarkAdaptationStatus =
  "not-started" | "in-progress" | "validated" | "intentional-deviation"

/**
 * Evidence kinds accepted for benchmark adaptation validation.
 */
export type ExternalAgentBenchmarkEvidenceKind = "test" | "diagnostic" | "script"

export interface ExternalAgentBenchmarkEvidence {
  id: string
  kind: ExternalAgentBenchmarkEvidenceKind
  summary: string
  reference: string
  recordedAt: Date
}

export interface ExternalAgentIntentionalDeviationReview {
  reviewedBy: string
  reviewedAt: Date
  reviewLink?: string
}

export interface ExternalAgentIntentionalDeviationRecord {
  rationale: string
  tradeOff: string
  userImpact: string
  review: ExternalAgentIntentionalDeviationReview
}

/**
 * Benchmark capability map entry used for adaptation tracking.
 */
export interface ExternalAgentBenchmarkCapabilityEntry {
  id: string
  title: string
  referenceBehavior: string
  cogniaBehavior: string
  adaptationTarget: string
  gapGrade: ExternalAgentBenchmarkGapGrade
  status: ExternalAgentBenchmarkAdaptationStatus
  owner?: string
  evidence: ExternalAgentBenchmarkEvidence[]
  deviation?: ExternalAgentIntentionalDeviationRecord
  updatedAt: Date
}

/**
 * Support state for optional/unstable ACP extension methods.
 */
export type ExternalAgentSupportState = "unknown" | "supported" | "unsupported"

/**
 * ACP session extension methods tracked for support probing.
 */
export type ExternalAgentSessionExtensionMethod = "session/list" | "session/fork" | "session/resume"

/**
 * Support record for a specific extension method.
 */
export interface ExternalAgentExtensionSupportStatus {
  state: ExternalAgentSupportState
  reasonCode?: ExternalAgentBranchReasonCode
  reason?: string
  lastCheckedAt?: Date
}

/**
 * Support map for tracked ACP session extension methods.
 */
export interface ExternalAgentSessionExtensionSupport {
  "session/list": ExternalAgentExtensionSupportStatus
  "session/fork": ExternalAgentExtensionSupportStatus
  "session/resume": ExternalAgentExtensionSupportStatus
}

/**
 * Runtime validity snapshot for an external agent.
 */
export interface ExternalAgentValiditySnapshot {
  /** Canonical projection version for compatibility-safe consumers */
  contractVersion?: number
  /** Lifecycle completeness stage projected from runtime facts */
  lifecycleStage?: ExternalAgentLifecycleCompletenessStage
  /** Stage that is currently blocked (if any) */
  blockedStage?: ExternalAgentLifecycleCompletenessStage
  /** Canonical execution eligibility */
  executionEligibility?: ExternalAgentExecutionEligibility
  executable: boolean
  checkedAt: Date
  source: "config" | "connect" | "health" | "execution"
  blockingReasonCode?: ExternalAgentBranchReasonCode
  blockingReason?: string
  healthStatus?: "unknown" | "healthy" | "unhealthy"
  lastHealthCheckAt?: Date
  sessionExtensions: ExternalAgentSessionExtensionSupport
  negotiation?: {
    protocol: ExternalAgentProtocol
    protocolVersion?: number
    agentInfo?: AcpImplementationInfo
    authMethods?: AcpAuthMethod[]
    authRequired?: boolean
    agentCapabilities?: AcpAgentCapabilities
  }
  capabilitySnapshot?: ExternalAgentCapabilitySnapshot
  ecosystem?: ExternalAgentEcosystemReadinessSnapshot
  canonicalReasonCode?: ExternalAgentBranchReasonCode
  canonicalReason?: string
  branchOutcome?: ExternalAgentBranchOutcome
  correlation?: ExternalAgentCorrelationMetadata
  /**
   * Remediation advice as i18n key ids, resolved by the renderer against
   * `diagnostics.recoveryHint.*`. NOT display text — these cross into `lib/`,
   * which must stay locale-free.
   */
  recoveryHints?: string[]
  lastBranchReasonCode?: ExternalAgentBranchReasonCode
  lastBranchReason?: string
  lastBranchAt?: Date
}

/**
 * Connection status for external agents
 */
export type ExternalAgentConnectionStatus =
  "disconnected" | "connecting" | "connected" | "reconnecting" | "error"

/**
 * External agent execution status
 */
export type ExternalAgentStatus =
  | "idle"
  | "initializing"
  | "ready"
  | "executing"
  | "waiting_permission"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout"

// ============================================================================
// ACP-Specific Types (Agent Client Protocol)
// ============================================================================

/**
 * ACP Permission modes for tool execution
 * @see claude-code-acp PermissionMode
 */
export type AcpPermissionMode =
  | "default" // Normal permission flow
  | "acceptEdits" // Auto-accept file edits
  | "bypassPermissions" // Skip all permission checks
  | "plan" // Planning mode (no execution)
  | "dontAsk" // Don't prompt for permissions, deny if not pre-approved

/**
 * ACP Stop reasons for prompt turn completion
 * @see https://agentclientprotocol.com/protocol/prompt-turn#stop-reasons
 */
export type AcpStopReason =
  | "end_turn" // Language model finishes responding without requesting more tools
  | "max_tokens" // Maximum token limit reached
  | "max_turn_requests" // Maximum number of model requests in a single turn exceeded
  | "refusal" // Agent refuses to continue
  | "cancelled" // Client cancels the turn

/**
 * ACP Plan entry for agent planning
 * @see https://agentclientprotocol.com/protocol/agent-plan
 */
export interface AcpPlanEntry {
  /** Plan step content/description */
  content: string
  /** Priority level */
  priority: "high" | "medium" | "low"
  /** Current status */
  status: "pending" | "in_progress" | "completed" | "skipped"
}

/**
 * ACP Available command (slash command)
 * @see https://agentclientprotocol.com/protocol/slash-commands
 */
export interface AcpAvailableCommand {
  /** Command name (e.g., "compact", "clear") */
  name: string
  /** Command description */
  description: string
  /** Input hint if command accepts arguments */
  input?: { hint: string } | null
}

/**
 * ACP Session model state
 * @see claude-code-acp SessionModelState
 */
export interface AcpSessionModelState {
  /** Available models */
  availableModels: Array<{
    modelId: string
    name: string
    description?: string
  }>
  /** Currently selected model ID */
  currentModelId: string
}

/**
 * ACP Session modes state
 */
export interface AcpSessionModesState {
  /** Current mode ID */
  currentModeId: AcpPermissionMode
  /** Available modes */
  availableModes: Array<{
    id: AcpPermissionMode
    name: string
    description?: string
  }>
}

/**
 * ACP MCP Server configuration - stdio transport
 */
export interface AcpMcpServerStdio {
  /** Server name */
  name: string
  /** Command to execute */
  command: string
  /** Command arguments */
  args: string[]
  /** Environment variables */
  env?: Array<{ name: string; value: string }>
}

/**
 * ACP MCP Server configuration - HTTP transport
 */
export interface AcpMcpServerHttp {
  /** Transport type */
  type: "http"
  /** Server name */
  name: string
  /** Server URL */
  url: string
  /** HTTP headers */
  headers?: Array<{ name: string; value: string }>
}

/**
 * ACP MCP Server configuration - SSE transport (deprecated)
 */
export interface AcpMcpServerSse {
  /** Transport type */
  type: "sse"
  /** Server name */
  name: string
  /** SSE endpoint URL */
  url: string
  /** HTTP headers */
  headers?: Array<{ name: string; value: string }>
}

/**
 * Union of all MCP server configurations
 */
export type AcpMcpServerConfig = AcpMcpServerStdio | AcpMcpServerHttp | AcpMcpServerSse

/**
 * ACP Client capabilities for initialization
 * @see https://agentclientprotocol.com/protocol/initialization#client-capabilities
 */
export interface AcpClientCapabilities {
  /** File system capabilities */
  fs?: {
    /** Client can read text files */
    readTextFile?: boolean
    /** Client can write text files */
    writeTextFile?: boolean
  }
  /** Terminal capability - all terminal/* methods available */
  terminal?: boolean
  /** Session-level client features. */
  session?: {
    configOptions?: {
      /** Client can render and update boolean config options. */
      boolean?: Record<string, never>
    }
  }
  /** Client can receive experimental identified plan updates/removals. */
  plan?: Record<string, never>
  /** Custom capabilities via _meta */
  _meta?: Record<string, unknown>
}

/**
 * ACP Agent capabilities from initialization response
 * @see https://agentclientprotocol.com/protocol/initialization#agent-capabilities
 */
export interface AcpAgentCapabilities {
  /** Agent supports loading existing sessions */
  loadSession?: boolean
  /** Prompt content type capabilities */
  promptCapabilities?: {
    /** Agent accepts images in prompts */
    image?: boolean
    /** Agent accepts audio in prompts */
    audio?: boolean
    /** Agent accepts embedded context/resources */
    embeddedContext?: boolean
  }
  /** MCP transport capabilities */
  mcpCapabilities?: {
    /** Agent supports HTTP MCP transport */
    http?: boolean
    /** Agent supports SSE MCP transport (deprecated) */
    sse?: boolean
  }
  /** Session capabilities */
  sessionCapabilities?: {
    /** Fork session support (unstable) */
    fork?: Record<string, unknown>
    /** Resume session support */
    resume?: Record<string, unknown>
    /** Close session support (`session/close`) */
    close?: Record<string, unknown>
    /** Delete session support (`session/delete`) */
    delete?: Record<string, unknown>
    /** List sessions support (`session/list`) */
    list?: Record<string, unknown>
    /** Additional workspace roots on session lifecycle requests. */
    additionalDirectories?: Record<string, unknown>
  }
  /** Authentication capabilities */
  auth?: {
    /** Agent supports `logout` */
    logout?: boolean
  }
}

/**
 * ACP Client/Agent info for initialization
 */
export interface AcpImplementationInfo {
  /** Implementation name (programmatic) */
  name: string
  /** Display title (human-readable) */
  title?: string
  /** Version string */
  version: string
}

/**
 * ACP Authentication method
 */
export interface AcpAuthMethod {
  /** Auth method ID */
  id: string
  /** Auth method name */
  name: string
  /** Description */
  description?: string
  /** Custom metadata for auth */
  _meta?: Record<string, unknown>
}

/**
 * ACP Capability flags (legacy, for backward compatibility)
 * @deprecated Use AcpAgentCapabilities for new code
 */
export interface AcpCapabilities {
  /** Agent supports streaming responses */
  streaming?: boolean
  /** Agent can execute tools */
  toolExecution?: boolean
  /** Agent supports file operations */
  fileOperations?: boolean
  /** Agent supports code execution */
  codeExecution?: boolean
  /** Agent supports MCP tools */
  mcpTools?: boolean
  /** Agent supports multi-turn conversations */
  multiTurn?: boolean
  /** Agent supports context sharing */
  contextSharing?: boolean
  /** Agent supports thinking/chain-of-thought */
  thinking?: boolean
  /** Supported permission modes */
  permissionModes?: AcpPermissionMode[]
  /** Maximum context tokens */
  maxContextTokens?: number
  /** Supported file types */
  supportedFileTypes?: string[]
  /** Custom capabilities */
  custom?: Record<string, unknown>
}

// ============================================================================
// ACP Session Update Types (Notifications from Agent)
// ============================================================================

/**
 * ACP session update type discriminator
 * @see https://agentclientprotocol.com/protocol/prompt-turn
 */
export type AcpSessionUpdateType =
  | "agent_message_chunk"
  | "user_message_chunk"
  // Canonical ACP v1 reasoning-chunk discriminator.
  | "agent_thought_chunk"
  // Legacy/vendor alias retained for tolerance (some adapters emit this).
  | "thought_message_chunk"
  | "tool_call"
  | "tool_call_update"
  | "plan"
  | "plan_update"
  | "plan_removed"
  | "available_commands_update"
  | "mode_change"
  | "current_mode_update"
  // Canonical ACP v1 config-option discriminator (singular).
  | "config_option_update"
  // Legacy/vendor alias retained for tolerance (plural).
  | "config_options_update"
  // Context-window + cost reporting (ACP v1 UsageUpdate).
  | "usage_update"
  // Session metadata (title/updatedAt) update (ACP v1 SessionInfoUpdate).
  | "session_info_update"

/**
 * ACP Tool call status
 */
export type AcpToolCallStatus =
  "pending" | "in_progress" | "completed" | "failed" | "cancelled" | "error"

/**
 * ACP Tool call kind
 */
export type AcpToolCallKind =
  | "file_read"
  | "file_write"
  | "read"
  | "write"
  | "execute"
  | "terminal"
  | "browser"
  | "mcp"
  | "switch_mode"
  | "other"

/**
 * ACP Content block for session updates
 */
export interface AcpContentBlock {
  type: "text" | "image" | "audio" | "resource" | "resource_link" | "content"
  text?: string
  data?: string
  mimeType?: string
  uri?: string
  /** Resource name (for resource_link) */
  name?: string
  /** Resource title (for resource_link) */
  title?: string
  /** Resource description (for resource_link) */
  description?: string
  /** Resource size in bytes (for resource_link) */
  size?: number
  resource?: {
    uri: string
    mimeType?: string
    text?: string
    blob?: string
  }
  content?: AcpContentBlock
  /** Content annotations */
  annotations?: AcpContentAnnotations
}

/**
 * ACP Agent message chunk update
 */
export interface AcpAgentMessageChunkUpdate {
  sessionUpdate: "agent_message_chunk"
  content: AcpContentBlock
}

/**
 * ACP User message chunk update
 */
export interface AcpUserMessageChunkUpdate {
  sessionUpdate: "user_message_chunk"
  content: AcpContentBlock
}

/**
 * ACP Thought message chunk update.
 *
 * The canonical ACP v1 discriminator is `agent_thought_chunk`; the
 * `thought_message_chunk` value is retained as a tolerated alias so adapters
 * emitting the older string still surface reasoning.
 */
export interface AcpThoughtMessageChunkUpdate {
  sessionUpdate: "agent_thought_chunk" | "thought_message_chunk"
  content: AcpContentBlock
}

/**
 * ACP Usage update — context window occupancy + cumulative session cost.
 * @see https://agentclientprotocol.com/protocol/prompt-turn
 */
export interface AcpUsageUpdate {
  sessionUpdate: "usage_update"
  /** Tokens currently in context. */
  used: number
  /** Total context window size in tokens. */
  size: number
  /** Cumulative session cost (optional). */
  cost?: { amount: number; currency: string } | null
}

/**
 * ACP Session info update — session metadata (title / last-activity).
 */
export interface AcpSessionInfoUpdate {
  sessionUpdate: "session_info_update"
  title?: string | null
  updatedAt?: string | null
}

/**
 * ACP Tool call update (initial)
 */
export interface AcpToolCallUpdate {
  sessionUpdate: "tool_call"
  toolCallId: string
  title: string
  kind: AcpToolCallKind
  status: AcpToolCallStatus
  /** Content produced by the tool call */
  content?: AcpToolCallContent[]
  /** File locations affected by this tool call */
  locations?: AcpToolCallLocation[]
  /** Raw input parameters sent to the tool */
  rawInput?: Record<string, unknown>
  /** Raw output returned by the tool */
  rawOutput?: Record<string, unknown>
}

/**
 * ACP Tool call status update
 */
export interface AcpToolCallStatusUpdate {
  sessionUpdate: "tool_call_update"
  toolCallId: string
  status?: AcpToolCallStatus
  title?: string
  kind?: AcpToolCallKind
  content?: AcpToolCallContent[]
  /** File locations affected by this tool call */
  locations?: AcpToolCallLocation[]
  /** Raw input parameters sent to the tool */
  rawInput?: Record<string, unknown>
  /** Raw output returned by the tool */
  rawOutput?: Record<string, unknown>
}

/**
 * ACP Plan update
 */
export interface AcpPlanUpdate {
  sessionUpdate: "plan"
  entries: AcpPlanEntry[]
}

/** Identified plan content used by the current ACP SDK extension. */
export type AcpPlanUpdateContent =
  | { type: "items"; planId: string; entries: AcpPlanEntry[] }
  | { type: "file"; planId: string; uri: string }
  | { type: "markdown"; planId: string; content: string }

/** Current ACP identified-plan update notification. */
export interface AcpPlanContentUpdate {
  sessionUpdate: "plan_update"
  plan: AcpPlanUpdateContent
}

/** Current ACP identified-plan removal notification. */
export interface AcpPlanRemovedUpdate {
  sessionUpdate: "plan_removed"
  planId: string
}

/**
 * ACP Available commands update
 */
export interface AcpAvailableCommandsUpdate {
  sessionUpdate: "available_commands_update"
  availableCommands: AcpAvailableCommand[]
}

/**
 * ACP Mode change update
 * @deprecated Use config_options_update with category 'mode' instead
 */
export interface AcpModeChangeUpdate {
  sessionUpdate: "mode_change"
  modeId: AcpPermissionMode
}

/**
 * ACP Current mode update (agent-initiated mode change)
 * @see https://agentclientprotocol.com/protocol/session-modes
 */
export interface AcpCurrentModeUpdate {
  sessionUpdate: "current_mode_update"
  currentModeId: string
}

// ============================================================================
// ACP Session Config Options
// @see https://agentclientprotocol.com/protocol/session-config-options
// ============================================================================

/**
 * Config option category for semantic UX hints
 * Categories starting with '_' are for custom use
 */
export type AcpConfigOptionCategory = "mode" | "model" | "model_config" | "thought_level" | string

/**
 * Config option type supported by ACP v1.
 */
export type AcpConfigOptionType = "select" | "boolean"

/**
 * A single value within a config option
 */
export interface AcpConfigOptionValue {
  /** The value identifier used when setting this option */
  value: string
  /** Human-readable name to display */
  name: string
  /** Optional description of what this value does */
  description?: string
}

/** A named group of select values. */
export interface AcpConfigOptionGroup {
  group: string
  name: string
  options: AcpConfigOptionValue[]
}

/**
 * A configuration option for a session
 * @see https://agentclientprotocol.com/protocol/session-config-options
 */
interface AcpConfigOptionBase {
  /** Unique identifier for this configuration option */
  id: string
  /** Human-readable label for the option */
  name: string
  /** Optional description */
  description?: string
  /** Semantic category for UX hints */
  category?: AcpConfigOptionCategory
}

export type AcpConfigOption = AcpConfigOptionBase &
  (
    | {
        type: "select"
        currentValue: string
        options: AcpConfigOptionValue[] | AcpConfigOptionGroup[]
      }
    | {
        type: "boolean"
        currentValue: boolean
      }
  )

/**
 * ACP Config options update (session notification)
 * @see https://agentclientprotocol.com/protocol/session-config-options
 */
export interface AcpConfigOptionsUpdate {
  // Canonical ACP v1 uses the singular `config_option_update`; the plural is a
  // tolerated alias. Both carry the full `configOptions` set.
  sessionUpdate: "config_option_update" | "config_options_update"
  configOptions: AcpConfigOption[]
}

// ============================================================================
// ACP Tool Call Content Types
// @see https://agentclientprotocol.com/protocol/tool-calls
// ============================================================================

/**
 * Diff content produced by tool calls
 */
export interface AcpToolCallDiffContent {
  type: "diff"
  /** Absolute file path being modified */
  path: string
  /** Original content (null for new files) */
  oldText: string | null
  /** New content after modification */
  newText: string
}

/**
 * Terminal content embedded in tool calls
 */
export interface AcpToolCallTerminalContent {
  type: "terminal"
  /** ID of a terminal created with terminal/create */
  terminalId: string
}

/**
 * Regular content embedded in tool calls
 */
export interface AcpToolCallRegularContent {
  type: "content"
  content: AcpContentBlock
}

/**
 * Union of all tool call content types
 */
export type AcpToolCallContent =
  AcpToolCallRegularContent | AcpToolCallDiffContent | AcpToolCallTerminalContent

/**
 * File location affected by a tool call (for follow-along features)
 */
export interface AcpToolCallLocation {
  /** Absolute file path being accessed or modified */
  path: string
  /** Optional line number within the file */
  line?: number
}

/**
 * ACP fs/read_text_file params
 * @see https://agentclientprotocol.com/protocol/file-system
 */
export interface AcpReadTextFileParams {
  /** Session whose workspace roots authorize this request */
  sessionId: string
  /** Absolute file path */
  path: string
  /** 1-based line number to start from */
  line?: number
  /** Maximum number of lines to return */
  limit?: number
  /** Optional metadata */
  _meta?: Record<string, unknown>
}

/** ACP fs/write_text_file params. */
export interface AcpWriteTextFileParams {
  sessionId: string
  path: string
  content: string
  _meta?: Record<string, unknown>
}

/**
 * ACP terminal/create params
 * @see https://agentclientprotocol.com/protocol/terminals
 */
export interface AcpTerminalCreateParams {
  sessionId: string
  command: string
  args?: string[]
  cwd?: string
  env?: Array<{ name: string; value: string }>
  outputByteLimit?: number
  _meta?: Record<string, unknown>
}

/**
 * ACP terminal/output params
 * @see https://agentclientprotocol.com/protocol/terminals
 */
export interface AcpTerminalOutputParams {
  sessionId: string
  terminalId: string
  outputByteLimit?: number
  _meta?: Record<string, unknown>
}

/**
 * Permission option kind
 * @see https://agentclientprotocol.com/protocol/tool-calls
 */
export type AcpPermissionOptionKind =
  "allow_once" | "allow_always" | "reject_once" | "reject_always"

/**
 * Permission option presented to the user
 */
export interface AcpPermissionOption {
  /** Unique identifier for this option */
  optionId: string
  /** Human-readable label */
  name: string
  /** Kind hint for UI treatment */
  kind: AcpPermissionOptionKind
  /** Optional description */
  description?: string
  /** Whether this is the default option */
  isDefault?: boolean
  /** Optional metadata */
  _meta?: Record<string, unknown>
}

/**
 * Permission request outcome
 */
export interface AcpPermissionOutcome {
  outcome: "selected" | "cancelled"
  optionId?: string
}

// ============================================================================
// ACP Content Annotations
// @see https://agentclientprotocol.com/protocol/content
// ============================================================================

/**
 * Annotations on content blocks
 */
export interface AcpContentAnnotations {
  /** Intended audience */
  audience?: ("user" | "assistant")[]
  /** Priority level */
  priority?: number
  /** Custom annotation data */
  _meta?: Record<string, unknown>
}

/**
 * Audio content block
 * @see https://agentclientprotocol.com/protocol/content
 */
export interface AcpAudioContentBlock {
  type: "audio"
  /** Base64-encoded audio data */
  data: string
  /** MIME type of the audio (e.g., "audio/wav", "audio/mp3") */
  mimeType: string
  /** Optional annotations */
  annotations?: AcpContentAnnotations
}

/**
 * Terminal exit status
 * @see https://agentclientprotocol.com/protocol/terminals
 */
export interface AcpTerminalExitStatus {
  /** Process exit code (may be null if terminated by signal) */
  exitCode: number | null
  /** Signal that terminated the process (may be null if exited normally) */
  signal: string | null
}

/**
 * ACP terminal/output result
 * @see https://agentclientprotocol.com/protocol/terminals
 */
export interface AcpTerminalOutputResult {
  output: string
  truncated: boolean
  exitStatus: AcpTerminalExitStatus
  /** Backward-compatible field */
  exitCode?: number | null
}

/**
 * Union of all ACP session update types
 */
export type AcpSessionUpdate =
  | AcpAgentMessageChunkUpdate
  | AcpUserMessageChunkUpdate
  | AcpThoughtMessageChunkUpdate
  | AcpToolCallUpdate
  | AcpToolCallStatusUpdate
  | AcpPlanUpdate
  | AcpPlanContentUpdate
  | AcpPlanRemovedUpdate
  | AcpAvailableCommandsUpdate
  | AcpModeChangeUpdate
  | AcpCurrentModeUpdate
  | AcpConfigOptionsUpdate
  | AcpUsageUpdate
  | AcpSessionInfoUpdate

/**
 * ACP session/update notification params
 */
export interface AcpSessionUpdateNotification {
  sessionId: string
  update: AcpSessionUpdate
}

/**
 * ACP Tool information from agent
 */
export interface AcpToolInfo {
  id: string
  name: string
  description?: string
  parameters?: Record<string, unknown>
  requiresPermission?: boolean
  category?: string
  mcpServer?: {
    id: string
    name: string
  }
}

/**
 * ACP Permission request from agent
 */
export interface AcpPermissionRequest {
  id: string
  requestId?: string
  sessionId?: string
  toolCallId?: string
  title?: string
  kind?: AcpToolCallKind
  toolInfo: AcpToolInfo
  options?: AcpPermissionOption[]
  rawInput?: Record<string, unknown>
  locations?: AcpToolCallLocation[]
  reason?: string
  riskLevel?: "low" | "medium" | "high" | "critical"
  autoApproveTimeout?: number
  metadata?: Record<string, unknown>
  _meta?: Record<string, unknown>
}

/**
 * ACP Permission response
 */
export interface AcpPermissionResponse {
  requestId: string
  granted: boolean
  reason?: string
  rememberChoice?: boolean
  scope?: "once" | "session" | "always"
  /** Option ID selected from ACP permission options */
  optionId?: string
  /**
   * Per-question answers for interactive user-input requests (Codex
   * `item/tool/requestUserInput`): question id → selected/typed answers.
   * Absent for plain approval decisions.
   */
  answers?: Record<string, string[]>
}

// ============================================================================
// External Agent Configuration
// ============================================================================

/**
 * Process spawn configuration for local agents
 */
export interface ExternalAgentProcessConfig {
  /** Command to execute */
  command: string
  /** Command arguments */
  args?: string[]
  /** Environment variables */
  env?: Record<string, string>
  /** Working directory */
  cwd?: string
  /** Shell to use (Windows) */
  shell?: boolean | string
  /** Timeout for process startup (ms) */
  startupTimeout?: number
  /** Keep process alive on disconnect */
  keepAlive?: boolean
  /** Restart on crash */
  restartOnCrash?: boolean
  /** Maximum restart attempts */
  maxRestarts?: number
  /**
   * Convenience: append `--bare` to `args` at spawn time so the agent skips
   * on-disk auto-discovery (hooks, skills, plugins, MCP, CLAUDE.md). Useful
   * for the Claude Code preset; ignored if `args` already contains `--bare`.
   */
  bare?: boolean
  /**
   * Convenience: append `--debug` to `args` at spawn time so the agent emits
   * verbose stderr logs. Ignored if `args` already contains `--debug`.
   */
  debug?: boolean
}

/**
 * Network configuration for remote agents
 */
export interface ExternalAgentNetworkConfig {
  /** Endpoint URL */
  endpoint: string
  /** Optional JSON-RPC endpoint (defaults to `${endpoint}/message`) */
  rpcEndpoint?: string
  /** Optional events endpoint for SSE (defaults to `${endpoint}/events`) */
  eventsEndpoint?: string
  /** Authentication method */
  authMethod?: "none" | "bearer" | "api-key" | "oauth2" | "custom"
  /** API key or token */
  apiKey?: string
  /** Bearer token */
  bearerToken?: string
  /** Custom headers */
  headers?: Record<string, string>
  /** Request timeout (ms) */
  timeout?: number
  /** Enable SSL/TLS verification */
  verifySsl?: boolean
  /** Proxy configuration */
  proxy?: {
    host: string
    port: number
    auth?: { username: string; password: string }
  }
}

/**
 * Retry configuration
 */
export interface ExternalAgentRetryConfig {
  /** Maximum retry attempts */
  maxRetries: number
  /** Initial retry delay (ms) */
  retryDelay: number
  /** Use exponential backoff */
  exponentialBackoff: boolean
  /** Maximum retry delay (ms) */
  maxRetryDelay?: number
  /** Retry on specific error codes */
  retryOnErrors?: string[]
}

/**
 * Complete external agent configuration
 */
export interface ExternalAgentConfig {
  /** Unique identifier */
  id: string
  /** Human-readable name */
  name: string
  /** Description */
  description?: string
  /** Protocol type */
  protocol: ExternalAgentProtocol
  /** Transport mechanism */
  transport: ExternalAgentTransport
  /** Whether agent is enabled */
  enabled: boolean

  /** Process configuration (for stdio transport) */
  process?: ExternalAgentProcessConfig
  /** Network configuration (for http/websocket/sse transport) */
  network?: ExternalAgentNetworkConfig

  /** Agent capabilities (discovered or configured) */
  capabilities?: AcpCapabilities

  /** Default permission mode */
  defaultPermissionMode?: AcpPermissionMode
  /** Auto-approve tools matching patterns */
  autoApprovePatterns?: string[]
  /** Tools requiring manual approval */
  requireApprovalFor?: string[]

  /** Codex app-server specific defaults (sandbox / reasoning options) */
  codexOptions?: CodexAgentOptions

  /** Execution timeout (ms) */
  timeout?: number
  /** Retry configuration */
  retryConfig?: ExternalAgentRetryConfig

  /** Maximum concurrent sessions */
  maxConcurrentSessions?: number
  /** Session idle timeout (ms) */
  sessionIdleTimeout?: number

  /** Tags for categorization */
  tags?: string[]
  /** Custom metadata */
  metadata?: Record<string, unknown>
  /** Last known runtime validity snapshot (best-effort projection) */
  validitySnapshot?: ExternalAgentValiditySnapshot

  /** Creation timestamp */
  createdAt?: Date
  /** Last updated timestamp */
  updatedAt?: Date
}

/**
 * Input for creating external agent configuration
 */
export interface CreateExternalAgentInput {
  name: string
  description?: string
  protocol: ExternalAgentProtocol
  transport: ExternalAgentTransport
  process?: ExternalAgentProcessConfig
  network?: ExternalAgentNetworkConfig
  defaultPermissionMode?: AcpPermissionMode
  autoApprovePatterns?: string[]
  requireApprovalFor?: string[]
  codexOptions?: CodexAgentOptions
  timeout?: number
  retryConfig?: Partial<ExternalAgentRetryConfig>
  tags?: string[]
  metadata?: Record<string, unknown>
  validitySnapshot?: ExternalAgentValiditySnapshot
}

/**
 * Input for updating external agent configuration
 */
export interface UpdateExternalAgentInput {
  name?: string
  description?: string
  enabled?: boolean
  process?: Partial<ExternalAgentProcessConfig>
  network?: Partial<ExternalAgentNetworkConfig>
  defaultPermissionMode?: AcpPermissionMode
  autoApprovePatterns?: string[]
  requireApprovalFor?: string[]
  codexOptions?: CodexAgentOptions
  timeout?: number
  retryConfig?: Partial<ExternalAgentRetryConfig>
  tags?: string[]
  metadata?: Record<string, unknown>
  validitySnapshot?: ExternalAgentValiditySnapshot
}

/**
 * Codex app-server per-agent option defaults. Applied at session creation
 * (thread/start `sandbox`, turn/start `sandboxPolicy` / `effort` / `summary`)
 * and adjustable per session via synthesized config options.
 */
export interface CodexAgentOptions {
  /** Sandbox mode for command execution (`SandboxPolicy` tag). */
  sandboxMode?: "readOnly" | "workspaceWrite" | "dangerFullAccess"
  /** Allow network access inside the sandbox (readOnly/workspaceWrite). */
  networkAccess?: boolean
  /** Extra writable roots for workspaceWrite. */
  writableRoots?: string[]
  /**
   * Absolute folder paths registered as extra Codex skill roots via the
   * `skills/extraRoots/set` app-server RPC. Codex discovers every `SKILL.md`
   * under these directories in addition to the default `.agents/skills`
   * locations. Re-applied on every connect (the server never persists them).
   */
  extraSkillRoots?: string[]
  /** Default reasoning effort (model-specific values, e.g. "low"…"xhigh"). */
  defaultReasoningEffort?: string
  /** Reasoning summary verbosity: "auto" | "concise" | "detailed" | "none". */
  reasoningSummary?: "auto" | "concise" | "detailed" | "none"
}

// ============================================================================
// External Agent Session
// ============================================================================

/**
 * Session status
 */
export type ExternalAgentSessionStatus =
  "creating" | "active" | "idle" | "executing" | "waiting" | "error" | "closing" | "closed"

/**
 * External agent session
 */
export interface ExternalAgentSession {
  /** Session ID */
  id: string
  /** Parent agent ID */
  agentId: string
  /** Session status */
  status: ExternalAgentSessionStatus
  /** Permission mode for this session */
  permissionMode?: AcpPermissionMode
  /**
   * Pre-approved tool allow-list for `dontAsk` mode. A tool matching an entry
   * is silently approved; everything else is denied without a UI prompt.
   */
  allowedTools?: string[]
  /** Discovered capabilities */
  capabilities?: AcpCapabilities
  /** Available tools in this session */
  tools?: AcpToolInfo[]

  /** Context passed to agent */
  context?: ExternalAgentContext
  /** Conversation history */
  messages?: ExternalAgentMessage[]

  /** Token usage in this session */
  tokenUsage?: ExternalAgentTokenUsage

  /** Creation timestamp */
  createdAt: Date
  /** Last activity timestamp */
  lastActivityAt: Date
  /** Expiry timestamp */
  expiresAt?: Date

  /** Error message if status is 'error' */
  error?: string
  /** Custom metadata */
  metadata?: Record<string, unknown>
}

/**
 * Context for external agent session
 */
export interface ExternalAgentContext {
  /** Parent task description */
  parentTask?: string
  /** Parent agent ID (if sub-agent) */
  parentAgentId?: string
  /** Shared context from parent */
  sharedContext?: Record<string, unknown>
  /** Working directory */
  workingDirectory?: string
  /** Available files */
  files?: string[]
  /** Environment info */
  environment?: {
    os?: string
    shell?: string
    editor?: string
    language?: string
  }
  /** Custom context data */
  custom?: Record<string, unknown>
}

/**
 * Token usage tracking
 */
export interface ExternalAgentTokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  /** Reasoning tokens reported separately by the external agent. */
  reasoningTokens?: number
  /** Tokens currently occupying the agent's live context, when reported. */
  contextTokens?: number
  /** The live model's authoritative context-window size, when reported. */
  modelContextWindow?: number
}

// ============================================================================
// External Agent Messages
// ============================================================================

/**
 * Message role
 */
export type ExternalAgentMessageRole = "user" | "assistant" | "system" | "tool"

/**
 * Content block types
 */
export type ExternalAgentContentType =
  "text" | "image" | "file" | "tool_use" | "tool_result" | "thinking" | "error"

/**
 * Text content block
 */
export interface ExternalAgentTextContent {
  type: "text"
  text: string
}

/**
 * Image content block
 */
export interface ExternalAgentImageContent {
  type: "image"
  source: {
    type: "base64" | "url"
    data?: string
    url?: string
    mediaType: string
  }
  alt?: string
}

/**
 * File content block
 */
export interface ExternalAgentFileContent {
  type: "file"
  path: string
  content?: string
  encoding?: "utf-8" | "base64"
  mimeType?: string
}

/**
 * Tool use content block
 */
export interface ExternalAgentToolUseContent {
  type: "tool_use"
  id: string
  name: string
  input: Record<string, unknown>
  status?: "pending" | "running" | "completed" | "error"
}

/**
 * Tool result content block
 */
export interface ExternalAgentToolResultContent {
  type: "tool_result"
  toolUseId: string
  content: string | Record<string, unknown>
  isError?: boolean
}

/**
 * Thinking content block (for chain-of-thought)
 */
export interface ExternalAgentThinkingContent {
  type: "thinking"
  thinking: string
}

/**
 * Error content block
 */
export interface ExternalAgentErrorContent {
  type: "error"
  error: string
  code?: string
  details?: Record<string, unknown>
}

/**
 * Union of all content block types
 */
export type ExternalAgentContent =
  | ExternalAgentTextContent
  | ExternalAgentImageContent
  | ExternalAgentFileContent
  | ExternalAgentToolUseContent
  | ExternalAgentToolResultContent
  | ExternalAgentThinkingContent
  | ExternalAgentErrorContent

/**
 * External agent message
 */
export interface ExternalAgentMessage {
  /** Message ID */
  id: string
  /** Message role */
  role: ExternalAgentMessageRole
  /** Content blocks */
  content: ExternalAgentContent[]
  /** Timestamp */
  timestamp: Date
  /** Token usage for this message */
  tokenUsage?: ExternalAgentTokenUsage
  /** Custom metadata */
  metadata?: Record<string, unknown>
}

// ============================================================================
// External Agent Events (Streaming)
// ============================================================================

/**
 * Event types for streaming responses
 */
export type ExternalAgentEventType =
  | "session_start"
  | "session_end"
  | "message_start"
  | "message_delta"
  | "message_end"
  | "content_block_start"
  | "content_block_delta"
  | "content_block_end"
  | "tool_use_start"
  | "tool_use_delta"
  | "tool_use_end"
  | "tool_result"
  | "tool_call_update"
  | "permission_request"
  | "permission_response"
  | "thinking"
  | "plan_update"
  | "commands_update"
  | "config_options_update"
  | "mode_update"
  | "progress"
  | "error"
  | "done"
  | "hook_fire"

/**
 * Base event interface
 */
export interface ExternalAgentEventBase {
  type: ExternalAgentEventType
  sessionId?: string
  timestamp: Date
}

/**
 * Session start event
 */
export interface ExternalAgentSessionStartEvent extends ExternalAgentEventBase {
  type: "session_start"
  capabilities?: AcpCapabilities
  tools?: AcpToolInfo[]
}

/**
 * Session end event
 */
export interface ExternalAgentSessionEndEvent extends ExternalAgentEventBase {
  type: "session_end"
  reason?: "completed" | "cancelled" | "error" | "timeout"
  error?: string
}

/**
 * Message start event
 */
export interface ExternalAgentMessageStartEvent extends ExternalAgentEventBase {
  type: "message_start"
  messageId?: string
  role?: ExternalAgentMessageRole
}

/**
 * Message delta event
 */
export interface ExternalAgentMessageDeltaEvent extends ExternalAgentEventBase {
  type: "message_delta"
  messageId?: string
  delta: {
    type: "text" | "thinking"
    text: string
  }
}

/**
 * Message end event
 */
export interface ExternalAgentMessageEndEvent extends ExternalAgentEventBase {
  type: "message_end"
  messageId?: string
  tokenUsage?: ExternalAgentTokenUsage
}

/**
 * Tool use start event
 */
export interface ExternalAgentToolUseStartEvent extends ExternalAgentEventBase {
  type: "tool_use_start"
  toolUseId: string
  toolName: string
  kind?: AcpToolCallKind
  rawInput?: Record<string, unknown>
  locations?: AcpToolCallLocation[]
}

/**
 * Tool use delta event
 */
export interface ExternalAgentToolUseDeltaEvent extends ExternalAgentEventBase {
  type: "tool_use_delta"
  toolUseId: string
  delta: string
}

/**
 * Tool use end event
 */
export interface ExternalAgentToolUseEndEvent extends ExternalAgentEventBase {
  type: "tool_use_end"
  toolUseId: string
  input: Record<string, unknown>
}

/**
 * Tool result event
 */
export interface ExternalAgentToolResultEvent extends ExternalAgentEventBase {
  type: "tool_result"
  toolUseId: string
  result: string | Record<string, unknown>
  isError?: boolean
  toolName?: string
  kind?: AcpToolCallKind
  rawInput?: Record<string, unknown>
  rawOutput?: Record<string, unknown>
  locations?: AcpToolCallLocation[]
  status?: AcpToolCallStatus
}

/**
 * Permission request event
 */
export interface ExternalAgentPermissionRequestEvent extends ExternalAgentEventBase {
  type: "permission_request"
  request: AcpPermissionRequest
}

/**
 * Permission response event
 */
export interface ExternalAgentPermissionResponseEvent extends ExternalAgentEventBase {
  type: "permission_response"
  response: AcpPermissionResponse
}

/**
 * Thinking event
 */
export interface ExternalAgentThinkingEvent extends ExternalAgentEventBase {
  type: "thinking"
  thinking: string
}

/**
 * Plan update event
 */
export interface ExternalAgentPlanUpdateEvent extends ExternalAgentEventBase {
  type: "plan_update"
  entries: AcpPlanEntry[]
  progress: number
  step: number
  totalSteps: number
  /** Stable plan identifier for ACP's identified-plan extension. */
  planId?: string
  /** Identified plan representation. Legacy `plan` updates use `items`. */
  kind?: "items" | "file" | "markdown"
  /** File URI when `kind` is `file`. */
  uri?: string
  /** Raw markdown when `kind` is `markdown`. */
  content?: string
  /** True when the identified plan was removed. */
  removed?: boolean
}

/** Active non-item plan representation exposed by ACP identified plans. */
export interface ExternalAgentPlanDocument {
  planId: string
  kind: "file" | "markdown"
  uri?: string
  content?: string
}

/**
 * Available commands update event
 */
export interface ExternalAgentCommandsUpdateEvent extends ExternalAgentEventBase {
  type: "commands_update"
  commands: AcpAvailableCommand[]
}

/**
 * Config options update event
 * @see https://agentclientprotocol.com/protocol/session-config-options
 */
export interface ExternalAgentConfigOptionsUpdateEvent extends ExternalAgentEventBase {
  type: "config_options_update"
  configOptions: AcpConfigOption[]
}

/**
 * Mode update event (agent-initiated mode change)
 * @see https://agentclientprotocol.com/protocol/session-modes
 */
export interface ExternalAgentModeUpdateEvent extends ExternalAgentEventBase {
  type: "mode_update"
  modeId: string
}

/**
 * Tool call update event (enhanced with diff, locations, etc.)
 * @see https://agentclientprotocol.com/protocol/tool-calls
 */
export interface ExternalAgentToolCallUpdateEvent extends ExternalAgentEventBase {
  type: "tool_call_update"
  toolCallId: string
  status?: AcpToolCallStatus
  title?: string
  kind?: AcpToolCallKind
  content?: AcpToolCallContent[]
  locations?: AcpToolCallLocation[]
  rawInput?: Record<string, unknown>
  rawOutput?: Record<string, unknown>
}

/**
 * Progress event
 */
export interface ExternalAgentProgressEvent extends ExternalAgentEventBase {
  type: "progress"
  progress: number
  message?: string
  step?: number
  totalSteps?: number
}

/**
 * Error event
 */
export interface ExternalAgentErrorEvent extends ExternalAgentEventBase {
  type: "error"
  error: string
  code?: string
  recoverable?: boolean
}

/**
 * Done event
 */
export interface ExternalAgentDoneEvent extends ExternalAgentEventBase {
  type: "done"
  success: boolean
  tokenUsage?: ExternalAgentTokenUsage
  stopReason?: AcpStopReason
}

/**
 * Hook-fire event — a synthetic event the manager emits when a consequential
 * settings.json/plugin lifecycle hook fired for this external-agent turn
 * (blocked a tool, injected context, or warned). Mirrors the built-in agent's
 * Rust `hook_fire` system event; `event-to-parts` projects it into a
 * `hook-notice` part rendered inline by the chat. No-op fires are never emitted.
 */
export interface ExternalAgentHookFireEvent extends ExternalAgentEventBase {
  type: "hook_fire"
  /** Lifecycle event name, e.g. "PreToolUse" / "PostToolUse". */
  event: string
  toolName?: string
  /** Derived status, by precedence block > context > warning. */
  outcome: "blocked" | "context" | "warning"
  block?: string
  additionalContext?: string
  warnings: string[]
}

/**
 * Union of all event types
 */
export type ExternalAgentEvent =
  | ExternalAgentSessionStartEvent
  | ExternalAgentSessionEndEvent
  | ExternalAgentMessageStartEvent
  | ExternalAgentMessageDeltaEvent
  | ExternalAgentMessageEndEvent
  | ExternalAgentToolUseStartEvent
  | ExternalAgentToolUseDeltaEvent
  | ExternalAgentToolUseEndEvent
  | ExternalAgentToolResultEvent
  | ExternalAgentToolCallUpdateEvent
  | ExternalAgentPermissionRequestEvent
  | ExternalAgentPermissionResponseEvent
  | ExternalAgentThinkingEvent
  | ExternalAgentPlanUpdateEvent
  | ExternalAgentCommandsUpdateEvent
  | ExternalAgentConfigOptionsUpdateEvent
  | ExternalAgentModeUpdateEvent
  | ExternalAgentProgressEvent
  | ExternalAgentErrorEvent
  | ExternalAgentDoneEvent
  | ExternalAgentHookFireEvent

// ============================================================================
// External Agent Execution
// ============================================================================

/**
 * Execution step
 */
export interface ExternalAgentStep {
  id: string
  stepNumber: number
  type: "thinking" | "message" | "tool_call" | "tool_result" | "error"
  status: "pending" | "running" | "completed" | "failed" | "skipped"
  content?: ExternalAgentContent[]
  toolCall?: {
    id: string
    name: string
    input: Record<string, unknown>
  }
  toolResult?: {
    toolCallId: string
    result: string | Record<string, unknown>
    isError?: boolean
  }
  startedAt?: Date
  completedAt?: Date
  duration?: number
  error?: string
}

/**
 * Execution result
 */
export interface ExternalAgentResult {
  /** Whether execution was successful */
  success: boolean
  /** Session ID used */
  sessionId: string
  /** Final response text */
  finalResponse: string
  /** All messages in conversation */
  messages: ExternalAgentMessage[]
  /** Execution steps */
  steps: ExternalAgentStep[]
  /** Tool calls made */
  toolCalls: Array<{
    id: string
    name: string
    input: Record<string, unknown>
    result?: string | Record<string, unknown>
    status: "pending" | "completed" | "error"
    error?: string
  }>
  /** Total duration (ms) */
  duration: number
  /** Token usage */
  tokenUsage?: ExternalAgentTokenUsage
  /** Structured output */
  output?: Record<string, unknown>
  /** Error message if failed */
  error?: string
  /** Error code */
  errorCode?: string
}

/**
 * Execution options
 */
export interface ExternalAgentExecutionOptions {
  /** Reuse an existing external agent session */
  sessionId?: string
  /**
   * Model id the external agent should run this execution on.
   *
   * Bridged to the adapter as `metadata.selectedModel` — the same channel the
   * interactive model picker writes — so a new session starts on it and a
   * reused session is switched onto it via `setSessionModel`. Best-effort:
   * adapters with no model concept ignore it, and the id is passed through
   * unvalidated (the agent rejects one it doesn't know).
   *
   * Omit to inherit whatever the agent's own configuration selects.
   */
  model?: string
  /** System prompt override */
  systemPrompt?: string
  /** Permission mode override */
  permissionMode?: AcpPermissionMode
  /**
   * Pre-approved tool allow-list. Under the `dontAsk` permission mode the ACP
   * client silently approves a tool whose name matches an entry here and
   * rejects everything else (no UI prompt). Ignored by other modes. Entries are
   * bare tool names or `Tool(specifier)` patterns (the Claude Agent SDK
   * `allowedTools` format); see `deriveExternalSessionPermission`.
   */
  allowedTools?: string[]
  /**
   * Cognia-specific brief-output mode. When true, the ACP client prepends a
   * concise-output snippet to the resolved `systemPrompt` for `session/new`.
   * No-op if the spawned agent doesn't honour `systemPrompt` (we ship a
   * best-effort fallback rather than fail the connect).
   */
  briefMode?: boolean
  /** Execution timeout (ms) */
  timeout?: number
  /** Maximum steps */
  maxSteps?: number
  /** Context to pass to agent */
  context?: ExternalAgentContext
  /** Explicit working directory for ACP session creation */
  workingDirectory?: string
  /** Structured instruction payload for protocol-specific metadata bridging */
  instructionEnvelope?: {
    hash: string
    developerInstructions: string
    customInstructions?: string
    skillsSummary?: string
    sourceFlags?: Record<string, boolean>
    projectContextSummary?: string
  }
  /** Files to include */
  files?: Array<{ path: string; content?: string }>
  /** Callback for events */
  onEvent?: (event: ExternalAgentEvent) => void
  /** Callback for permission requests */
  onPermissionRequest?: (request: AcpPermissionRequest) => Promise<AcpPermissionResponse>
  /** Callback for progress */
  onProgress?: (progress: number, message?: string) => void
  /** Abort signal */
  signal?: AbortSignal
  /** Agent trace context for event correlation */
  traceContext?: {
    sessionId?: string
    turnId?: string
    traceId?: string
    spanId?: string
    parentSpanId?: string
    tracestate?: string
    tags?: string[]
    metadata?: Record<string, unknown>
  }
}

// ============================================================================
// External Agent Instance (Runtime)
// ============================================================================

/**
 * Runtime instance of an external agent
 */
export interface ExternalAgentInstance {
  /** Configuration */
  config: ExternalAgentConfig
  /** Connection status */
  connectionStatus: ExternalAgentConnectionStatus
  /** Agent status */
  status: ExternalAgentStatus
  /** Active sessions */
  sessions: Map<string, ExternalAgentSession>
  /** Discovered capabilities */
  capabilities?: AcpCapabilities
  /** Available tools */
  tools?: AcpToolInfo[]
  /** Runtime validity snapshot used for gating/projection */
  validity?: ExternalAgentValiditySnapshot
  /** Durable execution snapshot independent of transient error banners */
  lastRunSnapshot?: ExternalAgentLastRunSnapshot
  /** Process ID (for stdio transport) */
  processId?: number
  /** Last error */
  lastError?: string
  /** Connection attempts */
  connectionAttempts: number
  /** Last connection attempt timestamp */
  lastConnectionAttempt?: Date
  /** Statistics */
  stats: {
    totalExecutions: number
    successfulExecutions: number
    failedExecutions: number
    totalTokensUsed: number
    averageResponseTime: number
  }
}

// ============================================================================
// Delegation & Routing
// ============================================================================

/**
 * Delegation rule for routing tasks to external agents
 */
export interface ExternalAgentDelegationRule {
  /** Rule ID */
  id: string
  /** Rule name */
  name: string
  /** Condition type */
  condition: "task-type" | "capability" | "keyword" | "tool-needed" | "always" | "custom"
  /** Matcher pattern or function serialized as string */
  matcher: string
  /** Target external agent ID */
  targetAgentId: string
  /** Rule priority (higher = checked first) */
  priority: number
  /** Whether rule is enabled */
  enabled: boolean
  /** Optional description */
  description?: string
}

/**
 * Result of checking delegation rules
 */
export interface ExternalAgentDelegationResult {
  /** Whether task should be delegated */
  shouldDelegate: boolean
  /** Target agent ID if delegating */
  targetAgentId?: string
  /** Matched rule if any */
  matchedRule?: ExternalAgentDelegationRule
  /** Reason for decision */
  reason?: string
  /** Machine-readable branch reason code */
  reasonCode?: ExternalAgentBranchReasonCode
}

// ============================================================================
// Defaults & Constants
// ============================================================================

/**
 * Default retry configuration
 */
export const DEFAULT_EXTERNAL_AGENT_RETRY_CONFIG: ExternalAgentRetryConfig = {
  maxRetries: 3,
  retryDelay: 1000,
  exponentialBackoff: true,
  maxRetryDelay: 30000,
}

/**
 * Default external agent configuration
 */
export const DEFAULT_EXTERNAL_AGENT_CONFIG: Partial<ExternalAgentConfig> = {
  enabled: true,
  protocol: "acp",
  transport: "stdio",
  defaultPermissionMode: "default",
  timeout: 300000, // 5 minutes
  retryConfig: DEFAULT_EXTERNAL_AGENT_RETRY_CONFIG,
  maxConcurrentSessions: 3,
  sessionIdleTimeout: 600000, // 10 minutes
}

/**
 * Status display configuration
 */
export const EXTERNAL_AGENT_STATUS_CONFIG: Record<
  ExternalAgentStatus,
  {
    label: string
    color: string
    icon: string
    animate?: boolean
  }
> = {
  idle: { label: "Idle", color: "text-muted-foreground", icon: "Circle" },
  initializing: { label: "Initializing", color: "text-blue-500", icon: "Loader2", animate: true },
  ready: { label: "Ready", color: "text-green-500", icon: "CheckCircle" },
  executing: { label: "Executing", color: "text-primary", icon: "Loader2", animate: true },
  waiting_permission: { label: "Waiting", color: "text-orange-500", icon: "AlertCircle" },
  paused: { label: "Paused", color: "text-yellow-500", icon: "Pause" },
  completed: { label: "Completed", color: "text-green-500", icon: "CheckCircle" },
  failed: { label: "Failed", color: "text-destructive", icon: "XCircle" },
  cancelled: { label: "Cancelled", color: "text-orange-500", icon: "Ban" },
  timeout: { label: "Timeout", color: "text-red-500", icon: "AlertTriangle" },
}

/**
 * Connection status display configuration
 */
export const EXTERNAL_AGENT_CONNECTION_STATUS_CONFIG: Record<
  ExternalAgentConnectionStatus,
  {
    label: string
    color: string
    icon: string
    animate?: boolean
  }
> = {
  disconnected: { label: "Disconnected", color: "text-muted-foreground", icon: "CircleOff" },
  connecting: { label: "Connecting", color: "text-blue-500", icon: "Loader2", animate: true },
  connected: { label: "Connected", color: "text-green-500", icon: "CheckCircle" },
  reconnecting: {
    label: "Reconnecting",
    color: "text-yellow-500",
    icon: "RefreshCw",
    animate: true,
  },
  error: { label: "Error", color: "text-destructive", icon: "AlertTriangle" },
}

// ============================================================================
// Serialization Helpers
// ============================================================================

/**
 * Serialize external agent config for storage
 */
export function serializeExternalAgentConfig(config: ExternalAgentConfig): string {
  return JSON.stringify({
    ...config,
    createdAt: config.createdAt?.toISOString(),
    updatedAt: config.updatedAt?.toISOString(),
  })
}

/**
 * Deserialize external agent config from storage
 */
export function deserializeExternalAgentConfig(data: string): ExternalAgentConfig {
  const parsed = JSON.parse(data)
  return {
    ...parsed,
    createdAt: parsed.createdAt ? new Date(parsed.createdAt) : undefined,
    updatedAt: parsed.updatedAt ? new Date(parsed.updatedAt) : undefined,
  }
}

/**
 * Serialize external agent session for storage
 */
export function serializeExternalAgentSession(session: ExternalAgentSession): string {
  return JSON.stringify({
    ...session,
    createdAt: session.createdAt.toISOString(),
    lastActivityAt: session.lastActivityAt.toISOString(),
    expiresAt: session.expiresAt?.toISOString(),
    messages: (session.messages ?? []).map((m) => ({
      ...m,
      timestamp: m.timestamp.toISOString(),
    })),
  })
}

/**
 * Deserialize external agent session from storage
 */
export function deserializeExternalAgentSession(data: string): ExternalAgentSession {
  const parsed = JSON.parse(data)
  return {
    ...parsed,
    createdAt: new Date(parsed.createdAt),
    lastActivityAt: new Date(parsed.lastActivityAt),
    expiresAt: parsed.expiresAt ? new Date(parsed.expiresAt) : undefined,
    messages: parsed.messages.map((m: Record<string, unknown>) => ({
      ...m,
      timestamp: new Date(m.timestamp as string),
    })),
  }
}

/**
 * Serialize external agent result for storage
 */
export function serializeExternalAgentResult(result: ExternalAgentResult): string {
  return JSON.stringify({
    ...result,
    messages: result.messages.map((m) => ({
      ...m,
      timestamp: m.timestamp.toISOString(),
    })),
    steps: result.steps.map((s) => ({
      ...s,
      startedAt: s.startedAt?.toISOString(),
      completedAt: s.completedAt?.toISOString(),
    })),
  })
}

/**
 * Deserialize external agent result from storage
 */
export function deserializeExternalAgentResult(data: string): ExternalAgentResult {
  const parsed = JSON.parse(data)
  return {
    ...parsed,
    messages: parsed.messages.map((m: Record<string, unknown>) => ({
      ...m,
      timestamp: new Date(m.timestamp as string),
    })),
    steps: parsed.steps.map((s: Record<string, unknown>) => ({
      ...s,
      startedAt: s.startedAt ? new Date(s.startedAt as string) : undefined,
      completedAt: s.completedAt ? new Date(s.completedAt as string) : undefined,
    })),
  }
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if content is text
 */
export function isTextContent(content: ExternalAgentContent): content is ExternalAgentTextContent {
  return content.type === "text"
}

/**
 * Check if content is image
 */
export function isImageContent(
  content: ExternalAgentContent
): content is ExternalAgentImageContent {
  return content.type === "image"
}

/**
 * Check if content is file
 */
export function isFileContent(content: ExternalAgentContent): content is ExternalAgentFileContent {
  return content.type === "file"
}

/**
 * Check if content is tool use
 */
export function isToolUseContent(
  content: ExternalAgentContent
): content is ExternalAgentToolUseContent {
  return content.type === "tool_use"
}

/**
 * Check if content is tool result
 */
export function isToolResultContent(
  content: ExternalAgentContent
): content is ExternalAgentToolResultContent {
  return content.type === "tool_result"
}

/**
 * Check if content is thinking
 */
export function isThinkingContent(
  content: ExternalAgentContent
): content is ExternalAgentThinkingContent {
  return content.type === "thinking"
}

/**
 * Check if content is error
 */
export function isErrorContent(
  content: ExternalAgentContent
): content is ExternalAgentErrorContent {
  return content.type === "error"
}

/**
 * Check if event is a streaming text event
 */
export function isStreamingTextEvent(
  event: ExternalAgentEvent
): event is ExternalAgentMessageDeltaEvent {
  return event.type === "message_delta" && event.delta.type === "text"
}

/**
 * Check if event is a tool use event
 */
export function isToolUseEvent(
  event: ExternalAgentEvent
): event is
  ExternalAgentToolUseStartEvent | ExternalAgentToolUseDeltaEvent | ExternalAgentToolUseEndEvent {
  return (
    event.type === "tool_use_start" ||
    event.type === "tool_use_delta" ||
    event.type === "tool_use_end"
  )
}

/**
 * Check if event is a permission event
 */
export function isPermissionEvent(
  event: ExternalAgentEvent
): event is ExternalAgentPermissionRequestEvent | ExternalAgentPermissionResponseEvent {
  return event.type === "permission_request" || event.type === "permission_response"
}
