/**
 * The external-agent adapter contract (ADR-0217).
 *
 * An adapter speaks one protocol to one configured agent. The contract is a
 * small required core plus named optional capabilities: a runtime implements
 * the capabilities it really has and nothing else, and callers ask with the
 * guards below instead of probing vendor classes. Unsupported operations are
 * absent, never stubbed to succeed.
 *
 * `ProtocolAdapter` (core + every capability optional) is the shape the host
 * manager has always consumed; it stays so existing adapters and plugins keep
 * compiling while callers move to the guards.
 */

import type {
  AcpAgentCapabilities,
  AcpAuthMethod,
  AcpAvailableCommand,
  AcpCapabilities,
  AcpCloseNesRequest,
  AcpCloseNesResponse,
  AcpConfigOption,
  AcpConnectMcpRequest,
  AcpConnectMcpResponse,
  AcpDidChangeDocumentNotification,
  AcpDidCloseDocumentNotification,
  AcpDidFocusDocumentNotification,
  AcpDidOpenDocumentNotification,
  AcpDidSaveDocumentNotification,
  AcpDisableProviderRequest,
  AcpDisableProviderResponse,
  AcpDisconnectMcpRequest,
  AcpDisconnectMcpResponse,
  AcpDynamicMcpConnectionState,
  AcpElicitationResponse,
  AcpImplementationInfo,
  AcpListProvidersResponse,
  AcpMcpServerConfig,
  AcpMessageMcpNotification,
  AcpMessageMcpRequest,
  AcpMessageMcpResponse,
  AcpPermissionMode,
  AcpPermissionResponse,
  AcpSessionModelState,
  AcpSetProviderRequest,
  AcpSetProviderResponse,
  AcpStartNesRequest,
  AcpStartNesResponse,
  AcpSuggestNesRequest,
  AcpSuggestNesResponse,
  AcpTerminalAuthState,
  AcpToolInfo,
  ExternalAgentConfig,
  ExternalAgentConnectionStatus,
  ExternalAgentEvent,
  ExternalAgentExecutionOptions,
  ExternalAgentMessage,
  ExternalAgentResult,
  ExternalAgentSession,
  ExternalAgentSessionExtensionSupport,
} from "./external-agent"
import type { AgentExecutionSemantics } from "./semantics"
import type {
  ExternalAgentCompactionCapability,
  ExternalAgentCompactionOptions,
  ExternalAgentProviderUndoCapability,
  ExternalAgentSessionEntry,
  ExternalAgentSessionForkTarget,
  ExternalAgentSessionHtmlExport,
  ExternalAgentSessionInput,
  ExternalAgentSessionInputAcceptance,
  ExternalAgentSessionInputMode,
  ExternalAgentSessionInputQueue,
  ExternalAgentSessionOperationCapabilities,
  ExternalAgentSessionQueuePolicy,
  ExternalAgentSessionRuntimeControls,
  ExternalAgentSessionRuntimeState,
  ExternalAgentSessionShellAbortResult,
  ExternalAgentSessionShellOptions,
  ExternalAgentSessionShellResult,
  ExternalAgentSessionTree,
} from "./session-operations"

/** Optional filters for protocol-backed session discovery. */
export interface SessionListOptions {
  /** Absolute working directory filter defined by ACP session/list. */
  cwd?: string
}

/** One session a runtime reports through {@link SessionListingCapability}. */
export interface ExternalAgentListedSession {
  sessionId: string
  cwd?: string
  additionalDirectories?: string[]
  title?: string
  createdAt?: string
  updatedAt?: string
  archived?: boolean
}

/**
 * Options for creating a session
 * @see https://agentclientprotocol.com/protocol/session-setup
 */
export interface SessionCreateOptions {
  /** Working directory for the session (absolute path, required by ACP) */
  cwd?: string
  /** Additional absolute workspace roots (ACP `additionalDirectories`). */
  additionalDirectories?: string[]
  /** MCP servers to connect to */
  mcpServers?: AcpMcpServerConfig[]
  /** Permission mode for the session */
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk"
  /**
   * Pre-approved tool allow-list, consulted only under `dontAsk` to silently
   * approve matching tools (see `ExternalAgentExecutionOptions.allowedTools`).
   */
  allowedTools?: string[]
  /** Context to pass to the agent */
  context?: Record<string, unknown>
  /** Structured instruction payload for protocol-specific metadata bridging */
  instructionEnvelope?: {
    hash: string
    developerInstructions: string
    customInstructions?: string
    skillsSummary?: string
    sourceFlags?: Record<string, boolean>
    projectContextSummary?: string
  }
  /** System prompt override */
  systemPrompt?: string
  /**
   * Cognia-specific brief-output mode. When true, the adapter prepends a
   * concise-output instruction to the resolved `systemPrompt` so the agent
   * favours short answers. No-op for agents that ignore `_meta.systemPrompt`.
   */
  briefMode?: boolean
  /** Session timeout (ms) */
  timeout?: number
  /**
   * Whether resume/fork should hydrate session history into
   * `ExternalAgentSession.messages` (default true). `false` maps to Codex's
   * `excludeTurns` (SDK `include_turns`) — the thread keeps full model
   * context; only the returned response carries no turns. Requires Codex CLI
   * ≥ 0.151; ignored by adapters without a history-selection concept.
   */
  includeHistory?: boolean
  /** Fork at a provider entry. Requires explicit forkAtEntry capability. */
  forkAtEntryId?: string
  /** Native identifier and inclusion semantics, published by the entry catalog. */
  forkAt?: ExternalAgentSessionForkTarget
  /** Session metadata */
  metadata?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Required core
// ---------------------------------------------------------------------------

/** What every adapter implements: connect, run a turn, cancel it, report health. */
export interface ExternalAgentAdapterCore {
  /** Protocol identifier */
  readonly protocol: string
  /** Current connection status */
  readonly connectionStatus: ExternalAgentConnectionStatus
  /** Discovered capabilities after connection */
  readonly capabilities?: AcpCapabilities
  /** Available tools after connection */
  readonly tools?: AcpToolInfo[]
  /**
   * How cancel, resume, fork, approvals and processes behave for this
   * runtime. Absent on adapters written before ADR-0217 (plugin adapters);
   * hosts then read {@link UNDECLARED_EXECUTION_SEMANTICS} from `./semantics`.
   */
  readonly semantics?: AgentExecutionSemantics

  /** Connect to the external agent. */
  connect(config: ExternalAgentConfig): Promise<void>
  /** Disconnect from the external agent. */
  disconnect(): Promise<void>
  /** Check if connected. */
  isConnected(): boolean
  /** Create a new session with the agent. */
  createSession(options?: SessionCreateOptions): Promise<ExternalAgentSession>
  /** Close an existing session. */
  closeSession(sessionId: string): Promise<void>
  /** Send a prompt and stream the agent's events. */
  prompt(
    sessionId: string,
    message: ExternalAgentMessage,
    options?: ExternalAgentExecutionOptions
  ): AsyncIterable<ExternalAgentEvent>
  /** Execute a complete interaction (non-streaming). */
  execute(
    sessionId: string,
    message: ExternalAgentMessage,
    options?: ExternalAgentExecutionOptions
  ): Promise<ExternalAgentResult>
  /** Respond to a permission request. Adapters without per-call approvals throw. */
  respondToPermission(sessionId: string, response: AcpPermissionResponse): Promise<void>
  /**
   * Cancel the in-flight execution. What it actually stops (turn, session or
   * process) is declared by `semantics.cancel`; a runtime that can only stop
   * its process must not report a turn-level cancel.
   */
  cancel(sessionId: string): Promise<void | ExternalAgentSessionInputQueue>
  /** Get a cached session by ID. */
  getSession(sessionId: string): ExternalAgentSession | undefined
  /** Get all cached sessions. */
  getSessions(): ExternalAgentSession[]
  /** Health check. */
  healthCheck(): Promise<boolean>
}

// ---------------------------------------------------------------------------
// Optional capabilities
// ---------------------------------------------------------------------------

/** Clears cached sessions after the backing process exits. */
export interface SessionRegistryCapability {
  forgetSessions(): void
}

/** Feature-gated ACP v1 elicitation answers. */
export interface ElicitationCapability {
  respondToElicitation(response: AcpElicitationResponse): Promise<void>
}

/** `$/cancel_request` by wire id. */
export interface RequestCancellationCapability {
  cancelRequest(requestId: number | string): Promise<void>
}

/** Session permission mode switching (ACP modes). */
export interface SessionModeCapability {
  setSessionMode(sessionId: string, modeId: AcpPermissionMode): Promise<void>
}

/**
 * Session model selection. `getSessionModels` is synchronous for ACP, which
 * keeps the state locally, and a promise for runtimes that ask their process.
 */
export interface SessionModelCapability {
  setSessionModel(sessionId: string, modelId: string): Promise<void>
  getSessionModels(
    sessionId: string
  ): AcpSessionModelState | undefined | Promise<AcpSessionModelState | undefined>
}

/** ACP session config options. */
export interface SessionConfigOptionsCapability {
  setConfigOption(
    sessionId: string,
    configId: string,
    value: string | boolean
  ): Promise<AcpConfigOption[]>
  getConfigOptions(
    sessionId: string
  ): AcpConfigOption[] | undefined | Promise<AcpConfigOption[] | undefined>
}

/** Append input to an in-flight turn without interrupting it. */
export interface TurnSteeringCapability {
  steerTurn(sessionId: string, text: string): Promise<void>
}

/** Events outside prompt ownership (an extension updating idle session UI). */
export interface SessionEventSubscriptionCapability {
  subscribeSessionEvents(
    sessionId: string,
    listener: (event: ExternalAgentEvent) => void
  ): () => void
}

/**
 * Independently optional session operations. Each method's presence is its
 * capability, resolved by `resolveSessionOperationCapabilities`; an
 * implementation must keep its normal policy and PII gates on every one.
 */
export interface SessionOperationMethods {
  getSessionOperationCapabilities?(
    sessionId: string
  ): Promise<Partial<ExternalAgentSessionOperationCapabilities>>
  refreshSessionCommands?(sessionId: string): Promise<AcpAvailableCommand[]>
  /** Execute a command without taking ownership of an already-running event stream. */
  executeSessionCommand?(
    sessionId: string,
    command: string
  ): Promise<ExternalAgentSessionInputAcceptance>
  enqueueSessionInput?(
    sessionId: string,
    input: ExternalAgentSessionInput,
    mode: ExternalAgentSessionInputMode
  ): Promise<ExternalAgentSessionInputAcceptance>
  clearSessionInputQueue?(sessionId: string): Promise<ExternalAgentSessionInputQueue>
  setSessionQueuePolicy?(sessionId: string, policy: ExternalAgentSessionQueuePolicy): Promise<void>
  setSessionRuntimeControls?(
    sessionId: string,
    controls: ExternalAgentSessionRuntimeControls
  ): Promise<void>
  getSessionRuntimeState?(sessionId: string): Promise<ExternalAgentSessionRuntimeState>
  abortSessionRetry?(sessionId: string): Promise<void>
  getSessionEntries?(sessionId: string, since?: string): Promise<ExternalAgentSessionEntry[]>
  getSessionTree?(sessionId: string): Promise<ExternalAgentSessionTree>
  cloneSession?(sessionId: string, options?: SessionCreateOptions): Promise<ExternalAgentSession>
  renameSession?(sessionId: string, name: string): Promise<void>
  archiveSession?(sessionId: string): Promise<void>
  unarchiveSession?(sessionId: string): Promise<void>
  exportSessionHtml?(sessionId: string): Promise<ExternalAgentSessionHtmlExport>
}

/** Provider shell execution; must apply native tool permissions itself. */
export interface SessionShellCapability {
  executeSessionShell(
    sessionId: string,
    command: string,
    options: ExternalAgentSessionShellOptions
  ): Promise<ExternalAgentSessionShellResult>
  abortSessionShell(sessionId: string): Promise<void | ExternalAgentSessionShellAbortResult>
}

/** Context compaction, resolving after provider-confirmed completion. */
export interface CompactionCapability {
  getCompactionCapability(sessionId: string): Promise<ExternalAgentCompactionCapability>
  compactSession(sessionId: string, options?: ExternalAgentCompactionOptions): Promise<void>
}

/** The provider's advertised `/undo`. */
export interface ProviderUndoCapability {
  getProviderUndoCapability(sessionId: string): Promise<ExternalAgentProviderUndoCapability>
  undoLastProviderChange(sessionId: string): Promise<void>
}

/** Session discovery (ACP v1 `session/list`). */
export interface SessionListingCapability {
  listSessions(options?: SessionListOptions): Promise<ExternalAgentListedSession[]>
}

/** Native fork. How it forks is declared by `semantics.fork`. */
export interface SessionForkCapability {
  forkSession(sessionId: string, options?: SessionCreateOptions): Promise<ExternalAgentSession>
}

/** Native resume. How it resumes is declared by `semantics.resume`. */
export interface SessionResumeCapability {
  resumeSession(sessionId: string, options?: SessionCreateOptions): Promise<ExternalAgentSession>
}

/** Remove a session from the agent's listings, as opposed to only ending it. */
export interface SessionDeletionCapability {
  deleteSession(sessionId: string): Promise<void | boolean>
}

/** Agent-side authentication. */
export interface AuthenticationCapability {
  getAuthMethods(): AcpAuthMethod[]
  isAuthenticationRequired(): boolean
  authenticate(methodId: string, credentials?: Record<string, unknown>): Promise<void>
}

/** Governed PTY authentication runs (ACP terminal auth methods). */
export interface TerminalAuthenticationCapability {
  getTerminalAuthState(): AcpTerminalAuthState | undefined
  cancelTerminalAuthentication(): Promise<void>
}

/** Sign out of the agent's authenticated session (ACP v1 `logout`). */
export interface LogoutCapability {
  logout(): Promise<void>
}

/** Provider configuration (ACP preview). */
export interface ProviderConfigurationCapability {
  listProviders(): Promise<AcpListProvidersResponse>
  setProvider(
    request: AcpSetProviderRequest,
    options?: { confirmedCredentialTransmission?: boolean }
  ): Promise<AcpSetProviderResponse>
  disableProvider(request: AcpDisableProviderRequest): Promise<AcpDisableProviderResponse>
}

/** Dynamic MCP lifecycle scoped to one connection (ACP preview). */
export interface DynamicMcpCapability {
  connectMcp(request: AcpConnectMcpRequest): Promise<AcpConnectMcpResponse>
  messageMcp(request: AcpMessageMcpRequest): Promise<AcpMessageMcpResponse>
  notifyMcpMessage(notification: AcpMessageMcpNotification): void
  disconnectMcp(request: AcpDisconnectMcpRequest): Promise<AcpDisconnectMcpResponse>
  getDynamicMcpConnections(): AcpDynamicMcpConnectionState[]
}

/** Next-edit suggestions (ACP preview). */
export interface NesCapability {
  startNes(request: AcpStartNesRequest): Promise<AcpStartNesResponse>
  suggestNes(request: AcpSuggestNesRequest): Promise<AcpSuggestNesResponse>
  closeNes(request: AcpCloseNesRequest): Promise<AcpCloseNesResponse>
}

/** Document synchronization notifications (ACP preview). */
export interface DocumentSyncCapability {
  didOpenDocument(notification: AcpDidOpenDocumentNotification): void
  didChangeDocument(notification: AcpDidChangeDocumentNotification): void
  didCloseDocument(notification: AcpDidCloseDocumentNotification): void
  didSaveDocument(notification: AcpDidSaveDocumentNotification): void
  didFocusDocument(notification: AcpDidFocusDocumentNotification): void
}

/** The negotiated ACP handshake. */
export interface AcpInitializationMetadata {
  protocolVersion?: number
  agentInfo?: AcpImplementationInfo
  agentCapabilities?: AcpAgentCapabilities
  authMethods?: AcpAuthMethod[]
}

/** ACP handshake and unstable-extension introspection. */
export interface AcpIntrospectionCapability {
  getAcpInitializationMetadata(): AcpInitializationMetadata
  getSessionExtensionSupport(): ExternalAgentSessionExtensionSupport
  clearSessionExtensionSupportCache(): void
}

/** One model a runtime offers before any session exists. */
export interface CatalogModel {
  id: string
  name?: string
}

/**
 * The runtime's own model catalog, readable without opening a session (Codex
 * `model/list`). Runtimes that publish models only inside a session (ACP)
 * leave this absent and the host opens a short-lived discovery session.
 */
export interface ModelCatalogCapability {
  listCatalogModels(): Promise<CatalogModel[]>
}

/** Every optional capability, each member optional. */
export type ExternalAgentAdapterOptionalCapabilities = Partial<
  SessionRegistryCapability &
    ElicitationCapability &
    RequestCancellationCapability &
    SessionModeCapability &
    SessionModelCapability &
    ModelCatalogCapability &
    SessionConfigOptionsCapability &
    TurnSteeringCapability &
    SessionEventSubscriptionCapability &
    SessionShellCapability &
    CompactionCapability &
    ProviderUndoCapability &
    SessionListingCapability &
    SessionForkCapability &
    SessionResumeCapability &
    SessionDeletionCapability &
    AuthenticationCapability &
    TerminalAuthenticationCapability &
    LogoutCapability &
    ProviderConfigurationCapability &
    DynamicMcpCapability &
    NesCapability &
    DocumentSyncCapability &
    AcpIntrospectionCapability
> &
  SessionOperationMethods

/**
 * The shape the host manager consumes: the required core with every
 * capability optional. Prefer the guards below over optional chaining when a
 * caller needs a whole capability.
 */
export interface ProtocolAdapter
  extends ExternalAgentAdapterCore, ExternalAgentAdapterOptionalCapabilities {}

export type ProtocolAdapterFactory = () => ProtocolAdapter

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function hasMethods(adapter: object, names: readonly string[]): boolean {
  const record = adapter as Record<string, unknown>
  return names.every((name) => typeof record[name] === "function")
}

export function supportsSessionRegistry<A extends ExternalAgentAdapterCore>(
  adapter: A
): adapter is A & SessionRegistryCapability {
  return hasMethods(adapter, ["forgetSessions"])
}

export function supportsSessionResume<A extends ExternalAgentAdapterCore>(
  adapter: A
): adapter is A & SessionResumeCapability {
  return hasMethods(adapter, ["resumeSession"])
}

export function supportsSessionFork<A extends ExternalAgentAdapterCore>(
  adapter: A
): adapter is A & SessionForkCapability {
  return hasMethods(adapter, ["forkSession"])
}

export function supportsTurnSteering<A extends ExternalAgentAdapterCore>(
  adapter: A
): adapter is A & TurnSteeringCapability {
  return hasMethods(adapter, ["steerTurn"])
}

export function supportsSessionModels<A extends ExternalAgentAdapterCore>(
  adapter: A
): adapter is A & SessionModelCapability {
  return hasMethods(adapter, ["setSessionModel", "getSessionModels"])
}

export function supportsModelCatalog<A extends ExternalAgentAdapterCore>(
  adapter: A
): adapter is A & ModelCatalogCapability {
  return hasMethods(adapter, ["listCatalogModels"])
}

export function supportsAuthentication<A extends ExternalAgentAdapterCore>(
  adapter: A
): adapter is A & AuthenticationCapability {
  return hasMethods(adapter, ["getAuthMethods", "isAuthenticationRequired", "authenticate"])
}

export function supportsCompaction<A extends ExternalAgentAdapterCore>(
  adapter: A
): adapter is A & CompactionCapability {
  return hasMethods(adapter, ["getCompactionCapability", "compactSession"])
}

export function supportsSessionListing<A extends ExternalAgentAdapterCore>(
  adapter: A
): adapter is A & SessionListingCapability {
  return hasMethods(adapter, ["listSessions"])
}

/** The required core members, in the order a structural check reports them. */
export const EXTERNAL_AGENT_ADAPTER_CORE_METHODS = [
  "connect",
  "disconnect",
  "isConnected",
  "createSession",
  "closeSession",
  "prompt",
  "execute",
  "respondToPermission",
  "cancel",
  "getSession",
  "getSessions",
  "healthCheck",
] as const

/** Core methods an object lacks; empty when it satisfies the core structurally. */
export function missingAdapterCoreMethods(candidate: object): string[] {
  const record = candidate as Record<string, unknown>
  return EXTERNAL_AGENT_ADAPTER_CORE_METHODS.filter((name) => typeof record[name] !== "function")
}
