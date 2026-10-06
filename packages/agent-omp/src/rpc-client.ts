/** Host-neutral OMP adapter. Product registration is intentionally outside this package. */
import { OmpOperationAdapter } from "./session-operations"
import { defineAdapterExtension } from "@cognia/agent-contracts/adapter-extension"
import type { SessionCreateOptions } from "@cognia/agent-contracts/adapter"
import type {
  AgentProcessHost,
  AgentOutboundGate,
  AgentLaunchEnvironmentResolver,
  Unsubscribe,
} from "@cognia/agent-contracts/host"
import type {
  AcpElicitationResponse,
  AcpPermissionResponse,
  ExternalAgentConfig,
  ExternalAgentEvent,
  ExternalAgentExecutionOptions,
  ExternalAgentMessage,
  ExternalAgentSession,
} from "@cognia/agent-contracts/external-agent"
import { OmpHostRequests, type OmpHostRequestsOptions } from "./host-requests"
import { OmpRpcPeer, OmpLocalRequestError, type OmpPromptTicket } from "./rpc-peer"
import { OmpSessionClient, type OmpRequestDispatch } from "./session-client"
import { OMP_RPC_PROTOCOL, OMP_VERIFIED_VERSION, OMP_RPC_EXECUTION_SEMANTICS } from "./manifest"
import {
  createOmpStreamState,
  mapOmpRpcEvent,
  ompStatsToTokenUsage,
  type OmpStreamState,
} from "./rpc-events"
import type {
  OmpCommandName,
  OmpCommandMap,
  OmpServerFrame,
  PromptParams,
  SessionState,
  SessionStats,
} from "./wire"

export interface OmpPreparedSession {
  cwd: string
  sessionDir: string
  trustedExtensionPath: string
  nonce: string
  env?: Record<string, string>
  /** Attestations supplied by the host after preparing and verifying the guard. */
  enforcement: {
    isolatedExtensions: boolean
    providerEgressControlled: boolean
    rebindingVerified: boolean
  }
  /** Revoke credentials, bootstrap files and guard transport after process termination. */
  release?(): Promise<void>
}
export interface OmpAdapterOptions {
  processHost: AgentProcessHost
  outboundGate: AgentOutboundGate
  probeRuntime(config: ExternalAgentConfig): Promise<{ command: string; version: string }>
  prepareSession(
    config: ExternalAgentConfig,
    options: SessionCreateOptions,
    resumeFile?: string
  ): Promise<OmpPreparedSession>
  resolveLaunchEnvironment?: AgentLaunchEnvironmentResolver
  timeoutMs?: number
  promptTimeoutMs?: number
  maxProcesses?: number
  maxBufferedEvents?: number
  maxBufferedBytes?: number
  hostTool?: OmpHostRequestsOptions["tool"]
  hostUri?: OmpHostRequestsOptions["uri"]
  onEvent?(event: ExternalAgentEvent): void
  onNativeEvent?(sessionId: string, event: OmpServerFrame): void
}
interface Runtime {
  id: string
  processId: string
  peer: OmpRpcPeer
  options: SessionCreateOptions
  prepared: OmpPreparedSession
  unsub: Unsubscribe[]
  stream: OmpStreamState
  state?: SessionState
  sink?: (event: ExternalAgentEvent) => void
  guardSeen: boolean
  guardResolve?: () => void
  exitObserved?: boolean
  closed: boolean
  spawning?: Promise<string>
  closing?: Promise<void>
  transition: boolean
  listeners: Set<(event: ExternalAgentEvent) => void>
  identityRevision: number
  requestsRevision: number
  stateRequestSequence: number
  settledRevision: number
  turnReserved?: boolean
  commandPending?: boolean
  activePrompt?: string
  requests?: OmpHostRequests
}
const transitions = new Set<OmpCommandName>([
  "new_session",
  "open_session",
  "switch_session",
  "branch",
  "fork",
])
const asError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)))

export class OmpRpcClientAdapter extends OmpOperationAdapter {
  readonly protocol = OMP_RPC_PROTOCOL
  readonly semantics = OMP_RPC_EXECUTION_SEMANTICS
  private runtime?: { command: string; version: string }
  private readonly live = new Map<string, Runtime>()
  private readonly locators = new Map<string, string>()
  private readonly resumeOptions = new Map<string, SessionCreateOptions>()
  private pendingCreates = 0
  private generation = 0
  constructor(private readonly host: OmpAdapterOptions) {
    super()
    if (typeof host.outboundGate !== "function") throw new TypeError("OMP outboundGate is required")
    for (const value of [
      host.timeoutMs,
      host.promptTimeoutMs,
      host.maxProcesses,
      host.maxBufferedEvents,
      host.maxBufferedBytes,
    ]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
        throw new TypeError("OMP limits must be positive integers")
    }
    if (host.maxProcesses !== undefined && host.maxProcesses > 4)
      throw new TypeError("OMP supports at most four dedicated processes per adapter")
    if (
      !host.processHost ||
      typeof host.probeRuntime !== "function" ||
      typeof host.prepareSession !== "function"
    )
      throw new TypeError("OMP process host and verified session preparation are required")
  }
  async connect(config: ExternalAgentConfig): Promise<void> {
    if (this.live.size) throw new Error("OMP processes must be reclaimed before reconnecting")
    if (this.isConnected()) throw new Error("OMP adapter is already connected")
    if (!this.host.processHost.available) throw new Error("OMP process host is unavailable")
    if (this._connectionStatus === "connecting")
      throw new Error("OMP connection is already in progress")
    const generation = this.generation
    this._connectionStatus = "connecting"
    try {
      const runtime = await this.host.probeRuntime(config)
      if (generation !== this.generation) throw new Error("OMP connection interrupted")
      if (runtime.version.replace(/^v/, "") !== OMP_VERIFIED_VERSION)
        throw new Error(
          `OMP ${runtime.version} has not been verified; expected ${OMP_VERIFIED_VERSION}`
        )
      if (!runtime.command) throw new Error("OMP executable is required")
      this.runtime = runtime
      this._config = config
      this._connectionStatus = "connected"
    } catch (error) {
      if (generation === this.generation) this._connectionStatus = "error"
      throw error
    }
  }
  async disconnect(): Promise<void> {
    this.generation++
    this._connectionStatus = "disconnected"
    const results = await Promise.allSettled(
      [...this.live.values()].map((r) => this.stop(r, new Error("OMP disconnected")))
    )
    this.runtime = undefined
    this._config = undefined
    this.locators.clear()
    this.resumeOptions.clear()
    const failed = results.find((r) => r.status === "rejected")
    if (failed?.status === "rejected") throw failed.reason
  }
  async createSession(options: SessionCreateOptions = {}): Promise<ExternalAgentSession> {
    return this.start(options)
  }
  async resumeSession(
    sessionId: string,
    options: SessionCreateOptions = {}
  ): Promise<ExternalAgentSession> {
    const file = this.locators.get(sessionId)
    if (!file) throw new Error("OMP resume requires a known native session file")
    if (this.live.has(sessionId)) throw new Error("OMP session is already running")
    return this.start({ ...this.resumeOptions.get(sessionId), ...options }, file)
  }
  /** Explicit host-authorized history locator; unlike resumeSession this may name an imported session. */
  async resumeFromFile(
    file: string,
    options: SessionCreateOptions = {}
  ): Promise<ExternalAgentSession> {
    if (!file || !file.endsWith(".jsonl"))
      throw new Error("OMP resume requires a JSONL session file")
    return this.start(options, file)
  }
  getResumeLocator(sessionId: string): string | undefined {
    return this.locators.get(sessionId)
  }
  private async start(
    options: SessionCreateOptions,
    resumeFile?: string
  ): Promise<ExternalAgentSession> {
    if (!this.isConnected() || !this._config || !this.runtime)
      throw new Error("OMP is not connected")
    if (this.live.size + this.pendingCreates >= (this.host.maxProcesses ?? 4))
      throw new Error("OMP process limit reached")
    if (!this.host.outboundGate(options))
      throw new Error("OMP outbound gate rejected session context")
    this.pendingCreates++
    let ownsReservation = true
    const generation = this.generation,
      config = this._config,
      command = this.runtime.command
    let r: Runtime | undefined, prepared: OmpPreparedSession | undefined
    try {
      prepared = await this.host.prepareSession(config, options, resumeFile)
      if (
        !prepared.nonce ||
        !prepared.trustedExtensionPath ||
        !prepared.sessionDir ||
        !prepared.cwd ||
        !Object.values(prepared.enforcement ?? {}).length ||
        !prepared.enforcement.isolatedExtensions ||
        !prepared.enforcement.providerEgressControlled ||
        !prepared.enforcement.rebindingVerified
      )
        throw new Error("OMP requires verified guard enforcement")
      if (generation !== this.generation || !this.isConnected())
        throw new Error("OMP disconnected during session preparation")
      const id = this.generateSessionId(),
        processId = `${config.id}:${id}`
      const peer = new OmpRpcPeer({
        outboundGate: this.host.outboundGate,
        timeoutMs: this.host.timeoutMs,
        promptTimeoutMs: this.host.promptTimeoutMs,
        send: (raw) => this.host.processHost.send(r!.processId, raw),
        onEvent: (frame) => this.receive(r!, frame),
        onFatal: (error) => {
          if (r) void this.stop(r, error).catch(() => {})
        },
      })
      r = {
        id,
        processId,
        peer,
        prepared,
        options,
        unsub: [],
        stream: createOmpStreamState(),
        guardSeen: false,
        closed: false,
        transition: false,
        settledRevision: 0,
        identityRevision: 0,
        requestsRevision: 0,
        stateRequestSequence: 0,
        listeners: new Set(),
      }
      this.bindHostRequests(r)
      this.live.set(id, r)
      this.pendingCreates--
      ownsReservation = false
      const check = () => {
        if (r!.closed || generation !== this.generation) throw new Error("OMP startup interrupted")
      }
      r.unsub.push(
        await this.host.processHost.onStdoutRaw((event) => {
          if (event.processId !== r!.processId || r!.closed) return
          try {
            const bytes = Uint8Array.from(atob(event.data), (c) => c.charCodeAt(0))
            peer.feed(bytes)
          } catch (error) {
            void this.stop(r!, asError(error)).catch(() => {})
          }
        })
      )
      check()
      r.unsub.push(
        await this.host.processHost.onExit((event) => {
          if (event.processId === r!.processId)
            void this.stop(r!, new Error(`OMP process exited (${event.code})`), false).catch(
              () => {}
            )
        })
      )
      check()
      const env = this.host.resolveLaunchEnvironment
        ? await this.host.resolveLaunchEnvironment(config, prepared.env ?? {})
        : prepared.env
      check()
      const args = [
        "--mode",
        "rpc",
        "--session-dir",
        prepared.sessionDir,
        "--trusted-extension",
        prepared.trustedExtensionPath,
      ]
      if (resumeFile) args.push("--resume", resumeFile)
      // OMP treats prompt arguments as text OR files. The trusted bootstrap must
      // project instructions into settings to avoid accidental file expansion.
      r.spawning = this.host.processHost.spawn({
        id: processId,
        command,
        args,
        cwd: prepared.cwd,
        env,
        framing: "raw",
      })
      const actual = await r.spawning
      if (actual !== processId) {
        r.processId = actual
        throw new Error("OMP host changed process ID after listeners were attached")
      }
      await peer.ready()
      await this.waitGuard(r)
      if (r.closed || generation !== this.generation)
        throw new Error("OMP session startup interrupted")
      const state = await peer.request("get_state")
      this.adopt(r, state)
      const now = new Date()
      const session: ExternalAgentSession = {
        id,
        agentId: config.id,
        status: state.isSettled ? "idle" : "active",
        createdAt: now,
        lastActivityAt: now,
        permissionMode: options.permissionMode ?? config.defaultPermissionMode,
        allowedTools: options.allowedTools,
        context: options.context,
        metadata: {
          ...options.metadata,
          nativeSessionId: state.sessionId,
          sessionFile: state.sessionFile,
          ompVersion: OMP_VERIFIED_VERSION,
        },
      }
      this._sessions.set(id, session)
      this.resumeOptions.set(id, options)
      await peer.request("set_ask_dialog", { enabled: true })
      return session
    } catch (error) {
      if (r) {
        await this.stop(r, asError(error))
        for (const unsubscribe of r.unsub.splice(0)) unsubscribe()
      } else await prepared?.release?.()
      throw error
    } finally {
      if (ownsReservation) this.pendingCreates--
    }
  }
  private async waitGuard(r: Runtime): Promise<void> {
    if (r.guardSeen) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        r.guardResolve = resolve
        timer = setTimeout(
          () => reject(new Error("OMP native guard handshake timed out")),
          this.host.timeoutMs ?? 30_000
        )
      })
    } finally {
      if (timer) clearTimeout(timer)
      r.guardResolve = undefined
    }
  }
  private adopt(r: Runtime, state: SessionState): void {
    if (!state.sessionId) throw new Error("OMP returned an invalid native session identity")
    r.state = state
    if (state.sessionFile) this.locators.set(r.id, state.sessionFile)
    else this.locators.delete(r.id)
    this.updateSession(r.id, {
      metadata: {
        ...this.getSession(r.id)?.metadata,
        nativeSessionId: state.sessionId,
        sessionFile: state.sessionFile,
      },
    })
  }
  private bindHostRequests(r: Runtime): void {
    r.requests?.dispose()
    r.requestsRevision = r.identityRevision
    r.requests = new OmpHostRequests({
      sessionId: r.id,
      requestScope: String(r.requestsRevision),
      send: (frame) => r.peer.sendFrame(frame),
      emit: (event) => this.emit(r, event),
      fatal: (error) => {
        void this.stop(r, error).catch(() => {})
      },
      tool: this.host.hostTool,
      uri: this.host.hostUri,
      timeoutMs: this.host.timeoutMs,
    })
  }
  private receive(r: Runtime, frame: OmpServerFrame): void {
    if (r.closed) return
    if (
      frame.type === "extension_ui_request" &&
      frame.method === "setStatus" &&
      frame.statusKey === "cognia-omp-ready"
    ) {
      if (frame.statusText !== r.prepared.nonce) {
        void this.stop(r, new Error("OMP native guard nonce mismatch")).catch(() => {})
        return
      }
      // The verified guard emits after the native identity has switched, before
      // subsequent host callbacks. Retire old approvals and work at that boundary.
      if (r.transition && r.requestsRevision !== r.identityRevision) this.bindHostRequests(r)
      r.guardSeen = true
      r.guardResolve?.()
    }
    if (frame.type === "session_settled") {
      r.settledRevision++
      if (r.state) r.state.isSettled = true
      this.updateSession(r.id, { status: "idle" })
    }
    try {
      this.host.onNativeEvent?.(r.id, frame)
    } catch {
      /* Observers cannot interrupt enforcement. */
    }
    if (r.requests?.handle(frame)) return
    for (const event of mapOmpRpcEvent(
      frame as unknown as { type: string; [key: string]: unknown },
      { sessionId: r.id, streamState: r.stream }
    ))
      this.emit(r, event)
  }
  private emit(r: Runtime, event: ExternalAgentEvent): void {
    r.sink?.(event)
    for (const listener of r.listeners) {
      try {
        listener(event)
      } catch {
        /* An observer cannot interrupt RPC. */
      }
    }
    try {
      this.host.onEvent?.(event)
    } catch {
      /* Consumer observers do not own process lifetime. */
    }
  }
  private getRuntime(id: string): Runtime {
    const r = this.live.get(id)
    if (!r || r.closed) throw new Error("OMP session is not running")
    return r
  }
  private async stop(r: Runtime, error: Error, kill = true): Promise<void> {
    if (!kill) r.exitObserved = true
    if (r.closing) return r.closing
    r.closed = true
    r.requests?.dispose()
    this.resetOmpOperations(r.id)
    r.peer.dispose(error)
    r.guardResolve?.()
    // Pending ticket rejection wakes the active stream; never enqueue into an overflowing sink.
    r.sink = undefined
    r.closing = Promise.resolve()
      .then(async () => {
        if (r.spawning) {
          const processId = await r.spawning.catch(() => undefined)
          if (processId) {
            r.processId = processId
            if (kill && !r.exitObserved) {
              try {
                await this.host.processHost.kill(processId)
                r.exitObserved = true
              } catch (error) {
                if (!r.exitObserved) throw error
              }
            }
          }
        }
        for (const unsubscribe of r.unsub.splice(0)) unsubscribe()
        await r.prepared.release?.()
        this.live.delete(r.id)
        this._sessions.delete(r.id)
        r.listeners.clear()
      })
      .catch((failure) => {
        // Retain the quarantined handle and lease until the host confirms death.
        r.closing = undefined
        this.updateSession(r.id, { status: "error", error: "OMP process cleanup failed" })
        throw failure
      })
    this.emit(r, {
      type: "error",
      sessionId: r.id,
      timestamp: new Date(),
      error: error.message,
      recoverable: false,
    })
    return r.closing
  }
  async closeSession(sessionId: string): Promise<void> {
    const r = this.live.get(sessionId)
    if (r) await this.stop(r, new Error("OMP session closed"))
  }
  async cancel(sessionId: string): Promise<void> {
    await this.stop(this.getRuntime(sessionId), new Error("OMP execution cancelled"))
  }
  async respondToPermission(_sessionId: string, _response: AcpPermissionResponse): Promise<void> {
    throw new Error("OMP native permissions are answered by the verified guard broker")
  }
  async respondToElicitation(response: AcpElicitationResponse): Promise<void> {
    const separator = response.requestId.indexOf(":omp:")
    if (separator < 0) throw new Error("Invalid OMP dialog id")
    const id = decodeURIComponent(response.requestId.slice(0, separator))
    await this.getRuntime(id).requests!.respond(response)
  }
  async executeSessionCommand(
    sessionId: string,
    command: string
  ): Promise<{ mode: "steer"; disposition: "handled" }> {
    const r = this.getRuntime(sessionId)
    if (r.transition || r.commandPending)
      throw new Error("OMP command or session transition is in progress")
    if (!this.host.outboundGate(command)) throw new Error("OMP outbound gate rejected command")
    r.commandPending = true
    try {
      const name = /^\/([^\s]+)(?:\s|$)/.exec(command)?.[1]
      const advertised = await r.peer.request("get_available_commands")
      if (
        !name ||
        !advertised.commands.some(
          (c) => c.source === "extension" && (c.name === name || c.aliases?.includes(name))
        )
      )
        throw new Error("OMP live command must be an advertised extension command")
      const ticket = r.peer.prompt({ message: command })
      // Always consume both promises; a refused admission also rejects completion.
      void ticket.result.catch(() => {})
      const ack = await ticket.ack
      if (ack?.agentInvoked !== false) {
        await this.stop(r, new Error("OMP extension command unexpectedly invoked an agent"))
        throw new Error("OMP command did not complete locally")
      }
      await ticket.result
      return { mode: "steer", disposition: "handled" }
    } finally {
      r.commandPending = false
    }
  }
  subscribeSessionEvents(
    sessionId: string,
    listener: (event: ExternalAgentEvent) => void
  ): () => void {
    const r = this.getRuntime(sessionId)
    r.listeners.add(listener)
    return () => r.listeners.delete(listener)
  }
  async forkSession(
    sessionId: string,
    options: SessionCreateOptions = {}
  ): Promise<ExternalAgentSession> {
    const parent = this.getRuntime(sessionId)
    if (parent.activePrompt || parent.turnReserved || parent.transition)
      throw new Error("OMP fork requires a settled session")
    const state = await parent.peer.request("get_state")
    if (!state.isSettled || !state.sessionFile)
      throw new Error("OMP fork requires a persisted settled session")
    if (
      options.forkAt &&
      (options.forkAt.kind !== "entry" || options.forkAt.boundary !== "through")
    )
      throw new Error("OMP forks include the selected message entry")
    const child = await this.resumeFromFile(state.sessionFile, { ...parent.options, ...options })
    try {
      const result = await this.getOmpSession(child.id).fork({
        entryId: options.forkAt?.id ?? options.forkAtEntryId,
      })
      if (result.cancelled) throw new Error("OMP fork was cancelled")
      return this.getSession(child.id)!
    } catch (error) {
      await this.closeSession(child.id)
      throw error
    }
  }
  async cloneSession(
    sessionId: string,
    options: SessionCreateOptions = {}
  ): Promise<ExternalAgentSession> {
    return this.forkSession(sessionId, options)
  }
  getOmpSession(sessionId: string): OmpSessionClient {
    const r = this.getRuntime(sessionId)
    return new OmpSessionClient({
      request: ((type: OmpCommandName, params: unknown) =>
        this.command(r, type, params)) as OmpRequestDispatch,
      prompt: (params, type) => this.beginPrompt(r, params, type),
    })
  }
  private async command<K extends OmpCommandName>(
    r: Runtime,
    type: K,
    params: unknown
  ): Promise<OmpCommandMap[K]["result"]> {
    this.getRuntime(r.id)
    if (type === "abort_bash") {
      await this.stop(r, new Error("OMP shell cancelled"))
      return undefined as OmpCommandMap[K]["result"]
    }
    if (type === "negotiate_protocol")
      throw new Error("OMP protocol negotiation is owned by the adapter")
    if (type === "set_event_filter" && params && typeof params === "object") {
      const filter = params as OmpCommandMap["set_event_filter"]["params"]
      if (filter.events !== null) throw new Error("OMP adapter requires the complete event stream")
    }
    if (
      (type === "set_host_tools" && !this.host.hostTool) ||
      (type === "set_host_uri_schemes" && !this.host.hostUri)
    )
      throw new Error("OMP host callbacks are not configured")
    if (r.transition) throw new Error("OMP session transition is in progress")
    const transition = transitions.has(type)
    if (
      transition &&
      (r.activePrompt || r.turnReserved || r.commandPending || r.state?.isSettled === false)
    )
      throw new Error("OMP session transition requires a settled session")
    const identityRevision = r.identityRevision
    const stateRequestSequence = type === "get_state" ? ++r.stateRequestSequence : undefined
    const previousIdentity = r.state?.sessionId
    const previousGuardSeen = r.guardSeen
    let transitionAdmitted = false
    if (transition) {
      r.transition = true
      r.identityRevision++
      r.guardSeen = false
    }
    try {
      const result = await (
        r.peer.request as (type: K, params: unknown) => Promise<OmpCommandMap[K]["result"]>
      )(type, params)
      if (transition) {
        transitionAdmitted = true
        const cancelled =
          typeof result === "object" &&
          result !== null &&
          "cancelled" in result &&
          result.cancelled === true
        const state = await r.peer.request("get_state")
        if (!cancelled && state.sessionId !== previousIdentity) await this.waitGuard(r)
        else r.guardSeen = true
        this.adopt(r, state)
        if (!cancelled) this.resetOmpOperations(r.id)
      }
      if (
        type === "get_state" &&
        !r.closed &&
        r.identityRevision === identityRevision &&
        r.stateRequestSequence === stateRequestSequence
      )
        this.adopt(r, result as SessionState)
      return result
    } catch (error) {
      if (transition) {
        if (!transitionAdmitted && error instanceof OmpLocalRequestError)
          r.guardSeen = previousGuardSeen
        else await this.stop(r, asError(error))
      }
      throw error
    } finally {
      if (transition) r.transition = false
    }
  }
  private beginPrompt(
    r: Runtime,
    params: PromptParams,
    type: "prompt" | "abort_and_prompt" = "prompt",
    reserved = false
  ): OmpPromptTicket {
    this.getRuntime(r.id)
    if (
      r.transition ||
      r.commandPending ||
      (r.turnReserved && !reserved) ||
      (r.activePrompt && type !== "abort_and_prompt")
    )
      throw new Error("OMP session already has an active prompt; use steer or followUp")
    if (!this.host.outboundGate(params)) throw new Error("OMP outbound gate rejected prompt")
    r.state = { ...r.state!, isSettled: false }
    r.stream = createOmpStreamState()
    this.updateSession(r.id, { status: "executing" })
    const revision = r.settledRevision
    const ticket = r.peer.prompt(params, type)
    r.activePrompt = ticket.id
    void ticket.result.then(
      (result) => {
        if (r.activePrompt !== ticket.id) return
        r.activePrompt = undefined
        const settled = result.sessionSettled || r.settledRevision > revision
        if (r.state) r.state.isSettled = settled
        this.updateSession(r.id, { status: settled ? "idle" : "active" })
      },
      (error) => {
        if (r.activePrompt === ticket.id) {
          r.activePrompt = undefined
          void this.stop(r, asError(error)).catch(() => {})
        }
      }
    )
    return ticket
  }
  async *prompt(
    sessionId: string,
    message: ExternalAgentMessage,
    options: ExternalAgentExecutionOptions = {}
  ): AsyncIterable<ExternalAgentEvent> {
    const r = this.getRuntime(sessionId)
    if (r.turnReserved || r.activePrompt || r.transition || r.commandPending)
      throw new Error("OMP session already has an active prompt")
    r.turnReserved = true
    try {
      yield* this.runPrompt(sessionId, message, options)
    } finally {
      r.turnReserved = false
    }
  }
  private async *runPrompt(
    sessionId: string,
    message: ExternalAgentMessage,
    options: ExternalAgentExecutionOptions
  ): AsyncIterable<ExternalAgentEvent> {
    const r = this.getRuntime(sessionId)
    if (r.sink || r.activePrompt) throw new Error("OMP session already has an active prompt")
    if (options.signal?.aborted) throw new Error("OMP prompt aborted")
    if (
      options.permissionMode !== undefined &&
      options.permissionMode !== this.getSession(sessionId)?.permissionMode
    )
      throw new Error("OMP permission changes require a newly prepared session")
    if (
      options.systemPrompt ||
      options.instructionEnvelope ||
      options.cogniaModel ||
      options.files?.length
    )
      throw new Error(
        "OMP instructions, files and model binding must be prepared through the host before session creation"
      )
    if (options.model) {
      const split = options.model.indexOf("/")
      if (split < 1) throw new Error("OMP model must use provider/modelId")
      await r.peer.request("set_model", {
        provider: options.model.slice(0, split),
        modelId: options.model.slice(split + 1),
      })
    }
    if (options.reasoningEffort)
      await r.peer.request("set_thinking_level", {
        level: options.reasoningEffort as OmpCommandMap["set_thinking_level"]["params"]["level"],
      })
    const params: PromptParams = { message: "", images: [] }
    for (const block of message.content) {
      if (block.type === "text") params.message += block.text
      else if (block.type === "image" && block.source.type === "base64" && block.source.data)
        params.images!.push({
          type: "image",
          data: block.source.data,
          mimeType: block.source.mediaType,
        })
      else throw new Error(`OMP cannot send content type ${block.type} without a host projection`)
    }
    if (!this.host.outboundGate(params)) throw new Error("OMP outbound gate rejected prompt")
    const queue: { event: ExternalAgentEvent; bytes: number }[] = []
    let bufferedBytes = 0
    let wake: (() => void) | undefined
    let finished = false
    let failure: Error | undefined
    r.sink = (event) => {
      const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength
      if (
        queue.length >= (this.host.maxBufferedEvents ?? 4096) ||
        bufferedBytes + bytes > (this.host.maxBufferedBytes ?? 64 * 1024 * 1024)
      ) {
        failure = new Error("OMP event consumer overflow")
        void this.stop(r, failure).catch(() => {})
        wake?.()
        return
      }
      queue.push({ event, bytes })
      bufferedBytes += bytes
      wake?.()
    }
    const abort = () => {
      void this.stop(r, new Error("OMP prompt aborted")).catch(() => {})
    }
    options.signal?.addEventListener("abort", abort, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    if (options.timeout) timer = setTimeout(abort, options.timeout)
    try {
      const before = await r.peer.request("get_session_stats")
      if (options.signal?.aborted) throw new Error("OMP prompt aborted")
      const ticket = this.beginPrompt(r, params, "prompt", true)
      void ticket.ack.catch(() => {})
      void ticket.result.then(
        async (result) => {
          try {
            const after = await r.peer.request("get_session_stats")
            const usage = turnUsage(before, after)
            if (result.status === "error")
              r.sink?.({
                type: "error",
                sessionId,
                timestamp: new Date(),
                error:
                  typeof result.error === "string"
                    ? result.error
                    : (result.error?.message ?? "OMP prompt failed"),
                recoverable: false,
              })
            r.sink?.({
              type: "done",
              sessionId,
              timestamp: new Date(),
              success: result.status === "completed",
              tokenUsage: usage,
            })
          } catch (error) {
            failure = asError(error)
          } finally {
            finished = true
            wake?.()
          }
        },
        (error) => {
          failure = asError(error)
          finished = true
          wake?.()
        }
      )
      while (!finished || queue.length) {
        if (failure) throw failure
        const queued = queue.shift()
        if (queued) {
          bufferedBytes -= queued.bytes
          yield queued.event
          continue
        }
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
      if (failure) throw failure
    } finally {
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener("abort", abort)
      r.sink = undefined
      if (!finished && !r.closed) await this.stop(r, new Error("OMP prompt consumer closed"))
    }
  }
}
function turnUsage(before: SessionStats, after: SessionStats) {
  const usage = ompStatsToTokenUsage(after)!
  usage.promptTokens = Math.max(0, after.tokens.input - before.tokens.input)
  usage.completionTokens = Math.max(0, after.tokens.output - before.tokens.output)
  usage.totalTokens = Math.max(0, after.tokens.total - before.tokens.total)
  usage.cacheReadTokens = Math.max(0, after.tokens.cacheRead - before.tokens.cacheRead)
  usage.cacheWriteTokens = Math.max(0, after.tokens.cacheWrite - before.tokens.cacheWrite)
  usage.providerCost = { amount: Math.max(0, after.cost - before.cost) }
  return usage
}
export const ompRpcExtension = defineAdapterExtension<{
  session(sessionId: string): OmpSessionClient
}>("omp.rpc", (adapter) =>
  adapter instanceof OmpRpcClientAdapter
    ? { session: (id) => adapter.getOmpSession(id) }
    : undefined
)
