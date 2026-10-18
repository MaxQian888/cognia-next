/**
 * ACP runtimes with process-scoped state need one transport per conversation.
 * Own child lifecycle, restore, cleanup and approval routing in one place.
 * The discovery transport carries no conversation credentials.
 */
import { defineAdapterExtension } from "@cognia/agent-contracts/adapter-extension"
import type {
  ExternalAgentConfig,
  ExternalAgentSession,
  ExternalAgentEvent,
  ExternalAgentMessage,
  ExternalAgentExecutionOptions,
  AcpConfigOption,
  AcpElicitationResponse,
} from "@cognia/agent-contracts/external-agent"
import type { AcpClientAdapter } from "./client"
import type { SessionCreateOptions } from "@cognia/agent-contracts/adapter"
import { SILENT_AGENT_LOGGER, type AgentLogger } from "@cognia/agent-contracts/host"
import { BaseProtocolAdapter } from "@cognia/agent-runtime-kit/base-adapter"
import { ACP_PROTOCOL, ISOLATED_ACP_EXECUTION_SEMANTICS } from "./manifest"
export class IsolatedAcpAdapter extends BaseProtocolAdapter {
  protected readonly isolationId: string = "acp"
  protected readonly label: string = "ACP"
  readonly protocol = ACP_PROTOCOL
  readonly semantics = ISOLATED_ACP_EXECUTION_SEMANTICS
  private readonly owners = new Map<string, AcpClientAdapter>()
  private readonly children = new Set<AcpClientAdapter>()
  private readonly disposals = new Map<AcpClientAdapter, Promise<void>>()
  private readonly childProcesses = new Map<string, AcpClientAdapter>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly restoring = new Set<string>()
  private readonly elicitations = new Map<
    string,
    {
      adapter: AcpClientAdapter
      id: string
      wireId?: number | string
    }
  >()
  private generation = 0
  private sequence = 0
  private stopping?: Promise<void>

  /**
   * `discovery` is the configuration-wide ACP transport; `createChild` builds
   * one per conversation over the same host ports.
   */
  constructor(
    private readonly discovery: AcpClientAdapter,
    private readonly createChild: () => AcpClientAdapter,
    private readonly log: AgentLogger = SILENT_AGENT_LOGGER
  ) {
    super()
  }

  override get connectionStatus() {
    return this._connectionStatus === "connected"
      ? this.discovery.connectionStatus
      : this._connectionStatus
  }

  override get capabilities() {
    return this.discovery.capabilities
  }
  override get tools() {
    return this.discovery.tools
  }
  override isConnected() {
    return this.connectionStatus === "connected"
  }

  async connect(config: ExternalAgentConfig): Promise<void> {
    await this.disconnect()
    this._config = config
    this._connectionStatus = "connecting"
    const generation = this.generation
    const connecting = Promise.resolve().then(() =>
      this.discovery.connect(this.processConfig("discovery"))
    )
    this.pending.add(connecting)
    try {
      await connecting
      if (generation !== this.generation) throw new Error(`${this.label} connection was cancelled`)
      this._connectionStatus = "connected"
    } catch (error) {
      await this.discovery.disconnect()
      if (generation === this.generation) this._connectionStatus = "error"
      throw error
    } finally {
      this.pending.delete(connecting)
    }
  }

  async disconnect(): Promise<void> {
    if (this.stopping) return this.stopping
    ++this.generation
    this._connectionStatus = "disconnected"
    this.stopping = (async () => {
      await Promise.allSettled([...this.pending])
      const results = await Promise.allSettled([
        this.discovery.disconnect(),
        ...Array.from(this.children, (child) => this.dispose(child)),
      ])
      this.owners.clear()
      this.elicitations.clear()
      this._sessions.clear()
      const failed = results.find((result) => result.status === "rejected")
      if (failed?.status === "rejected") throw failed.reason
    })()
    try {
      await this.stopping
    } finally {
      this.stopping = undefined
    }
  }

  protected processConfig(suffix: string, options?: SessionCreateOptions): ExternalAgentConfig {
    const config = this._config!
    if (!config.process || config.transport !== "stdio")
      throw new Error(`${this.label} ACP requires a stdio process configuration`)
    return {
      ...config,
      id: suffix === "discovery" ? config.id : `${config.id}:${this.isolationId}:${suffix}`,
      process: {
        ...config.process,
        cwd: options?.cwd ?? config.process.cwd,
        restartOnCrash: false,
        keepAlive: false,
      },
    }
  }

  protected sessionOptions(options?: SessionCreateOptions): SessionCreateOptions | undefined {
    return options
  }

  protected async prepareSession(
    _child: AcpClientAdapter,
    _session: ExternalAgentSession,
    _options?: SessionCreateOptions
  ): Promise<void> {}

  protected owner(sessionId: string): AcpClientAdapter {
    const child = this.owners.get(sessionId)
    if (!child) throw new Error(`Session not found: ${sessionId}`)
    return child
  }

  protected async dispose(child: AcpClientAdapter): Promise<void> {
    const existing = this.disposals.get(child)
    if (existing) return existing
    const disposing = Promise.resolve().then(() => this.disposeChild(child))
    this.disposals.set(child, disposing)
    try {
      await disposing
    } finally {
      this.disposals.delete(child)
    }
  }

  private async disposeChild(child: AcpClientAdapter): Promise<void> {
    try {
      await child.disconnect()
      this.children.delete(child)
      for (const [processId, owner] of this.childProcesses) {
        if (owner === child) this.childProcesses.delete(processId)
      }
    } finally {
      for (const [id, owner] of this.owners) {
        if (owner === child) {
          this.owners.delete(id)
          this._sessions.delete(id)
        }
      }
      for (const [id, entry] of this.elicitations) {
        if (entry.adapter === child) this.elicitations.delete(id)
      }
    }
  }

  private isolatedSession(
    operation: (child: AcpClientAdapter) => Promise<ExternalAgentSession>,
    options?: SessionCreateOptions,
    restoringId?: string
  ): Promise<ExternalAgentSession> {
    if (!this.isConnected()) return Promise.reject(new Error(`${this.label} is not connected`))
    if (restoringId && this.restoring.has(restoringId)) {
      return Promise.reject(new Error(`Session is already being restored: ${restoringId}`))
    }
    if (restoringId) this.restoring.add(restoringId)
    const generation = this.generation
    const child = this.createChild()
    this.children.add(child)
    const task = (async () => {
      try {
        if (restoringId && this.owners.has(restoringId)) {
          await this.dispose(this.owner(restoringId))
        }
        if (generation !== this.generation) throw new Error(`${this.label} session was cancelled`)
        const processConfig = this.processConfig(String(++this.sequence), options)
        this.childProcesses.set(processConfig.id, child)
        await child.connect(processConfig)
        if (generation !== this.generation) throw new Error(`${this.label} session was cancelled`)
        let session = await operation(child)
        await this.prepareSession(child, session, options)
        session = child.getSession(session.id) ?? session
        if (generation !== this.generation) throw new Error(`${this.label} session was cancelled`)
        if (this.owners.has(session.id))
          throw new Error(`Duplicate ${this.label} session: ${session.id}`)
        session.agentId = this._config!.id
        this.owners.set(session.id, child)
        this._sessions.set(session.id, session)
        return session
      } catch (error) {
        await this.dispose(child).catch(() => undefined)
        throw error
      } finally {
        if (restoringId) this.restoring.delete(restoringId)
      }
    })()
    this.pending.add(task)
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task)
    )
    return task
  }

  createSession(options?: SessionCreateOptions) {
    return this.isolatedSession(
      (child) => child.createSession(this.sessionOptions(options)),
      options
    )
  }
  loadSession(sessionId: string, options?: SessionCreateOptions) {
    return this.isolatedSession(
      (child) => child.loadSession(sessionId, this.sessionOptions(options)),
      options,
      sessionId
    )
  }
  resumeSession(sessionId: string, options?: SessionCreateOptions) {
    return this.isolatedSession(
      (child) => child.resumeSession(sessionId, this.sessionOptions(options)),
      options,
      sessionId
    )
  }
  async forkSession(sessionId: string, options?: SessionCreateOptions) {
    const metadata = this.getSession(sessionId)?.metadata
    const inherited = {
      ...(metadata?.instructionEnvelope
        ? { instructionEnvelope: metadata.instructionEnvelope }
        : {}),
      ...(typeof metadata?.cogniaSessionId === "string"
        ? { cogniaSessionId: metadata.cogniaSessionId }
        : {}),
    }
    const forkOptions = {
      ...(typeof metadata?.cwd === "string" ? { cwd: metadata.cwd } : {}),
      ...(Array.isArray(metadata?.additionalDirectories)
        ? {
            additionalDirectories: metadata.additionalDirectories.filter(
              (value): value is string => typeof value === "string"
            ),
          }
        : {}),
      ...options,
    }
    // Inherit conversation identity/instructions, never a parent's broker
    // credentials. The caller must supply a fresh session-bound MCP scope.
    const session = await this.isolatedSession(
      (child) => child.forkSession(sessionId, this.sessionOptions(forkOptions)),
      forkOptions
    )
    session.metadata = { ...inherited, ...session.metadata }
    return session
  }

  async closeSession(sessionId: string): Promise<void> {
    const child = this.owner(sessionId)
    try {
      await child.closeSession(sessionId)
    } finally {
      await this.dispose(child)
    }
  }
  async deleteSession(sessionId: string): Promise<void> {
    const child = this.owners.get(sessionId)
    if (!child) return this.discovery.deleteSession(sessionId)
    try {
      await child.deleteSession(sessionId)
    } finally {
      await this.dispose(child)
    }
  }

  override getSession(sessionId: string) {
    const child = this.owners.get(sessionId)
    if (!child || child.connectionStatus !== "connected") return undefined
    const session = child.getSession(sessionId)
    if (session?.status === "closed") return undefined
    if (session) session.agentId = this._config!.id
    return session
  }
  override getSessions() {
    return [...this.owners.keys()].flatMap((id) => this.getSession(id) ?? [])
  }
  override forgetSessions() {
    // Process-exit reconciliation is synchronous. Retain the shutdown promise
    // so the next connect waits for every process and credential directory.
    void this.disconnect().catch(() => {
      this._connectionStatus = "error"
    })
  }
  /** Native exit events use the child process ID, not the configured agent ID. */
  async handleProcessExit(processId: string): Promise<string[] | undefined> {
    const child = this.childProcesses.get(processId)
    if (!child) return undefined
    const sessions = [...this.owners].filter(([, owner]) => owner === child).map(([id]) => id)
    try {
      await this.dispose(child)
    } catch (error) {
      // Keep the failed cleanup handle for disconnect/retry; a failed child
      // must never trigger a reconnect that destroys healthy conversations.
      this.log.warn(`Failed to clean up exited ${this.label} child`, { processId, error })
    }
    return sessions
  }

  override async healthCheck() {
    for (const [processId, child] of this.childProcesses) {
      if (child.connectionStatus === "disconnected" || child.connectionStatus === "error") {
        await this.handleProcessExit(processId)
      }
    }
    // Session processes have independent health. Only losing discovery makes
    // the configured agent unavailable; a dead session can be resumed alone.
    return this.discovery.healthCheck()
  }

  async *prompt(
    sessionId: string,
    message: ExternalAgentMessage,
    options?: ExternalAgentExecutionOptions
  ): AsyncIterable<ExternalAgentEvent> {
    const child = this.owner(sessionId)
    for await (const event of child.prompt(sessionId, message, options)) {
      if (event.type === "elicitation_request") {
        const id = JSON.stringify([sessionId, event.request.id])
        this.elicitations.set(id, {
          adapter: child,
          id: event.request.id,
          wireId: event.request.requestId,
        })
        yield { ...event, request: { ...event.request, id, requestId: id } }
      } else {
        yield event
      }
    }
  }
  async respondToElicitation(response: AcpElicitationResponse): Promise<void> {
    const entry = this.elicitations.get(response.requestId)
    if (!entry) throw new Error(`Unknown ${this.label} elicitation request`)
    await entry.adapter.respondToElicitation({ ...response, requestId: entry.id })
    this.elicitations.delete(response.requestId)
  }
  async cancelRequest(requestId: string | number): Promise<void> {
    const entry = this.elicitations.get(String(requestId))
    if (!entry || entry.wireId === undefined)
      throw new Error(`Unknown ${this.label} request; cancel the session instead`)
    await entry.adapter.cancelRequest(entry.wireId)
    this.elicitations.delete(String(requestId))
  }
  respondToPermission(...args: Parameters<AcpClientAdapter["respondToPermission"]>) {
    return this.owner(args[0]).respondToPermission(...args)
  }
  cancel(...args: Parameters<AcpClientAdapter["cancel"]>) {
    return this.owner(args[0]).cancel(...args)
  }
  setSessionMode(...args: Parameters<AcpClientAdapter["setSessionMode"]>) {
    return this.owner(args[0]).setSessionMode(...args)
  }
  setSessionModel(...args: Parameters<AcpClientAdapter["setSessionModel"]>) {
    return this.owner(args[0]).setSessionModel(...args)
  }
  getSessionModels(...args: Parameters<AcpClientAdapter["getSessionModels"]>) {
    return this.owner(args[0]).getSessionModels(...args)
  }
  setConfigOption(...args: Parameters<AcpClientAdapter["setConfigOption"]>) {
    return this.owner(args[0]).setConfigOption(...args)
  }
  getConfigOptions(sessionId: string): AcpConfigOption[] | undefined {
    return this.owner(sessionId).getConfigOptions(sessionId)
  }
  getCompactionCapability(...args: Parameters<AcpClientAdapter["getCompactionCapability"]>) {
    return this.owner(args[0]).getCompactionCapability(...args)
  }
  compactSession(...args: Parameters<AcpClientAdapter["compactSession"]>) {
    return this.owner(args[0]).compactSession(...args)
  }
  getProviderUndoCapability(...args: Parameters<AcpClientAdapter["getProviderUndoCapability"]>) {
    return this.owner(args[0]).getProviderUndoCapability(...args)
  }
  undoLastProviderChange(...args: Parameters<AcpClientAdapter["undoLastProviderChange"]>) {
    return this.owner(args[0]).undoLastProviderChange(...args)
  }
  listSessions(...args: Parameters<AcpClientAdapter["listSessions"]>) {
    return this.discovery.listSessions(...args)
  }
  getAuthMethods(...args: Parameters<AcpClientAdapter["getAuthMethods"]>) {
    return this.discovery.getAuthMethods(...args)
  }
  isAuthenticationRequired(...args: Parameters<AcpClientAdapter["isAuthenticationRequired"]>) {
    return this.discovery.isAuthenticationRequired(...args)
  }
  authenticate(...args: Parameters<AcpClientAdapter["authenticate"]>) {
    return this.discovery.authenticate(...args)
  }
  getTerminalAuthState(...args: Parameters<AcpClientAdapter["getTerminalAuthState"]>) {
    return this.discovery.getTerminalAuthState(...args)
  }
  cancelTerminalAuthentication(
    ...args: Parameters<AcpClientAdapter["cancelTerminalAuthentication"]>
  ) {
    return this.discovery.cancelTerminalAuthentication(...args)
  }
  listProviders(...args: Parameters<AcpClientAdapter["listProviders"]>) {
    return this.discovery.listProviders(...args)
  }
  setProvider(...args: Parameters<AcpClientAdapter["setProvider"]>) {
    return this.discovery.setProvider(...args)
  }
  disableProvider(...args: Parameters<AcpClientAdapter["disableProvider"]>) {
    return this.discovery.disableProvider(...args)
  }
  startNes(...args: Parameters<AcpClientAdapter["startNes"]>) {
    return this.discovery.startNes(...args)
  }
  suggestNes(...args: Parameters<AcpClientAdapter["suggestNes"]>) {
    return this.discovery.suggestNes(...args)
  }
  closeNes(...args: Parameters<AcpClientAdapter["closeNes"]>) {
    return this.discovery.closeNes(...args)
  }
  didOpenDocument(...args: Parameters<AcpClientAdapter["didOpenDocument"]>) {
    return this.discovery.didOpenDocument(...args)
  }
  didChangeDocument(...args: Parameters<AcpClientAdapter["didChangeDocument"]>) {
    return this.discovery.didChangeDocument(...args)
  }
  didCloseDocument(...args: Parameters<AcpClientAdapter["didCloseDocument"]>) {
    return this.discovery.didCloseDocument(...args)
  }
  didSaveDocument(...args: Parameters<AcpClientAdapter["didSaveDocument"]>) {
    return this.discovery.didSaveDocument(...args)
  }
  didFocusDocument(...args: Parameters<AcpClientAdapter["didFocusDocument"]>) {
    return this.discovery.didFocusDocument(...args)
  }
  logout(...args: Parameters<AcpClientAdapter["logout"]>) {
    return this.discovery.logout(...args)
  }
  getAcpInitializationMetadata(
    ...args: Parameters<AcpClientAdapter["getAcpInitializationMetadata"]>
  ) {
    return this.discovery.getAcpInitializationMetadata(...args)
  }
  getSessionExtensionSupport(...args: Parameters<AcpClientAdapter["getSessionExtensionSupport"]>) {
    return this.discovery.getSessionExtensionSupport(...args)
  }
  clearSessionExtensionSupportCache(
    ...args: Parameters<AcpClientAdapter["clearSessionExtensionSupportCache"]>
  ) {
    return this.discovery.clearSessionExtensionSupportCache(...args)
  }
  getDynamicMcpConnections(...args: Parameters<AcpClientAdapter["getDynamicMcpConnections"]>) {
    return this.discovery.getDynamicMcpConnections(...args)
  }
}

export const isolatedAcpExtension = defineAdapterExtension<IsolatedAcpAdapter>(
  "acp.isolated",
  (adapter) => (adapter instanceof IsolatedAcpAdapter ? adapter : undefined)
)
