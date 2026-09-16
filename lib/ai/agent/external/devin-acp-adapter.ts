/**
 * Devin reads native MCP configuration once per process. Each conversation
 * therefore owns an ACP transport and an immutable host-prepared configuration.
 * The discovery transport carries no conversation credentials.
 */
import type {
  ExternalAgentConfig,
  ExternalAgentSession,
  ExternalAgentEvent,
  ExternalAgentMessage,
  ExternalAgentExecutionOptions,
  AcpConfigOption,
  AcpElicitationResponse,
} from "@/types/agent/external-agent"
import { loggers } from "@cognia/logging"
import { AcpClientAdapter } from "./acp-client"
import { BaseProtocolAdapter, type SessionCreateOptions } from "./protocol-adapter"
import {
  DEVIN_THOUGHT_LEVEL_OPTION_ID,
  devinModelIdForLevel,
  withDevinThoughtLevelOption,
} from "./devin-model-axis"
import { findModelConfigOption } from "./session-models"

export class DevinAcpAdapter extends BaseProtocolAdapter {
  readonly protocol = "acp"
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

  constructor(
    private readonly discovery = new AcpClientAdapter(),
    private readonly createChild: () => AcpClientAdapter = () => new AcpClientAdapter()
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
      if (generation !== this.generation) throw new Error("Devin connection was cancelled")
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

  private processConfig(suffix: string, options?: SessionCreateOptions): ExternalAgentConfig {
    const config = this._config!
    if (!config.process) throw new Error("Devin ACP requires a process configuration")
    return {
      ...config,
      id: suffix === "discovery" ? config.id : `${config.id}:devin:${suffix}`,
      process: {
        ...config.process,
        cwd: options?.cwd ?? config.process.cwd,
        restartOnCrash: false,
        keepAlive: false,
        env: {
          ...config.process.env,
          COGNIA_DEVIN_MCP_SERVERS: JSON.stringify(options?.mcpServers ?? []),
        },
      },
    }
  }

  private owner(sessionId: string): AcpClientAdapter {
    const child = this.owners.get(sessionId)
    if (!child) throw new Error(`Session not found: ${sessionId}`)
    return child
  }

  private async dispose(child: AcpClientAdapter): Promise<void> {
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
    if (!this.isConnected()) return Promise.reject(new Error("Devin is not connected"))
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
        if (generation !== this.generation) throw new Error("Devin session was cancelled")
        const processConfig = this.processConfig(String(++this.sequence), options)
        this.childProcesses.set(processConfig.id, child)
        await child.connect(processConfig)
        if (generation !== this.generation) throw new Error("Devin session was cancelled")
        const session = await operation(child)
        if (generation !== this.generation) throw new Error("Devin session was cancelled")
        if (this.owners.has(session.id)) throw new Error(`Duplicate Devin session: ${session.id}`)
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
      (child) => child.createSession({ ...options, mcpServers: [] }),
      options
    )
  }
  loadSession(sessionId: string, options?: SessionCreateOptions) {
    return this.isolatedSession(
      (child) => child.loadSession(sessionId, { ...options, mcpServers: [] }),
      options,
      sessionId
    )
  }
  resumeSession(sessionId: string, options?: SessionCreateOptions) {
    return this.isolatedSession(
      (child) => child.resumeSession(sessionId, { ...options, mcpServers: [] }),
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
      (child) => child.forkSession(sessionId, { ...forkOptions, mcpServers: [] }),
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
      loggers.agent.warn("Failed to clean up exited Devin child", { processId, error })
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
    if (!entry) throw new Error("Unknown Devin elicitation request")
    await entry.adapter.respondToElicitation({ ...response, requestId: entry.id })
    this.elicitations.delete(response.requestId)
  }
  async cancelRequest(requestId: string | number): Promise<void> {
    const entry = this.elicitations.get(String(requestId))
    if (!entry || entry.wireId === undefined)
      throw new Error("Unknown Devin request; cancel the session instead")
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
  /**
   * Devin publishes no `thought_level` option — its reasoning ladder lives
   * inside the `model` select's ids (`…-low`, `…-high`, `…-max`). A write to
   * the synthesized axis is therefore a `model` write to the family member
   * carrying that level; every other config id delegates unchanged. The reply
   * re-synthesizes the option so the caller sees model and thinking state
   * agree after the write.
   */
  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string | boolean
  ): Promise<AcpConfigOption[]> {
    const child = this.owner(sessionId)
    if (configId !== DEVIN_THOUGHT_LEVEL_OPTION_ID) {
      return child.setConfigOption(sessionId, configId, value)
    }
    const modelOption = findModelConfigOption(child.getConfigOptions(sessionId))
    const modelId = typeof value === "string" ? devinModelIdForLevel(modelOption, value) : undefined
    if (!modelOption || !modelId) {
      throw new Error(`Devin thinking level '${String(value)}' is not available on this model`)
    }
    await child.setConfigOption(sessionId, modelOption.id, modelId)
    return this.getConfigOptions(sessionId) ?? []
  }
  /**
   * The child's wire options plus the synthesized `thought_level` axis —
   * appended rather than merged into session metadata so the raw list stays
   * exactly what the agent sent (and a genuine `thought_level`, if Devin ever
   * publishes one, wins untouched).
   */
  getConfigOptions(sessionId: string): AcpConfigOption[] | undefined {
    return withDevinThoughtLevelOption(this.owner(sessionId).getConfigOptions(sessionId))
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
