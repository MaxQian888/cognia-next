import type {
  OpenCodeClient,
  ModelInfo,
  ModelRef,
  SessionInfo,
  SessionMessageInfo,
  PermissionRuleset,
} from "@opencode/client"
import { defineAdapterExtension } from "@cognia/agent-contracts/adapter-extension"
import type { SessionCreateOptions, SessionListOptions } from "@cognia/agent-contracts/adapter"
import type { AgentFetch, AgentOutboundGate } from "@cognia/agent-contracts/host"
import { BaseProtocolAdapter } from "@cognia/agent-runtime-kit/base-adapter"
import { promptInputPassesGate } from "@cognia/agent-runtime-kit/prompt-gate"
import { OPENCODE_V2_CURRENT_VERSION, type OpenCodeV2ServiceDiscovery } from "./discovery"
import { OPENCODE_V2_EXECUTION_SEMANTICS, OPENCODE_V2_PROTOCOL } from "./manifest"
import type {
  AcpAvailableCommand,
  AcpConfigOption,
  AcpElicitationRequest,
  AcpElicitationResponse,
  AcpPermissionMode,
  AcpPermissionResponse,
  AcpSessionModelState,
  ExternalAgentConfig,
  ExternalAgentEvent,
  ExternalAgentExecutionOptions,
  ExternalAgentMessage,
  ExternalAgentSession,
} from "@cognia/agent-contracts/external-agent"
import { validateAcpElicitationResponse } from "@cognia/agent-runtime-kit/elicitation"
import { OpenCodeV2EventMapper, mapOpenCodeV2Messages } from "./v2-events"
import {
  assertOpenCodeV2LocalPlacement,
  canProjectOpenCodeV2Mcp,
  type OpenCodeV2OwnedService,
  type OpenCodeV2Placement,
  type OpenCodeV2ServiceLauncher,
} from "./v2-launcher"
import type {
  ExternalAgentCompactionCapability,
  ExternalAgentCompactionOptions,
  ExternalAgentSessionEntry,
  ExternalAgentSessionInput,
  ExternalAgentSessionInputMode,
  ExternalAgentSessionInputAcceptance,
  ExternalAgentSessionInputQueue,
  ExternalAgentSessionOperationCapabilities,
} from "@cognia/agent-contracts/session-operations"

const NO_VARIANT = "#none"
const CURRENT_VERSION = OPENCODE_V2_CURRENT_VERSION

// The SDK is lazy-imported for code-splitting, so mirror its
// isSessionNotFoundError tag check rather than adding a static import.
function isSessionNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { _tag?: unknown })._tag === "SessionNotFoundError"
  )
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function modelRef(value: string): ModelRef {
  const slash = value.indexOf("/")
  if (slash <= 0 || slash === value.length - 1)
    throw new Error("OpenCode model must use provider/model format")
  const [id, variant] = value.slice(slash + 1).split("#")
  if (!id) throw new Error("OpenCode model must use provider/model format")
  return { providerID: value.slice(0, slash), id, ...(variant ? { variant } : {}) }
}

function permissionRules(
  mode: AcpPermissionMode,
  mountedServers: string[] = []
): PermissionRuleset {
  // Cognia's broker owns grants, confinement and approvals for its own tools.
  // Keep native policy intact while avoiding a second denial/approval gate.
  const projected: PermissionRuleset = mountedServers
    .filter((name) => ["cognia-tools", "cognia-plugin-tools"].includes(name))
    .map((name) => ({ action: `${name}_*`, resource: "*", effect: "allow" }))
  switch (mode) {
    case "default":
      return [{ action: "*", resource: "*", effect: "ask" }, ...projected]
    case "bypassPermissions":
      return [{ action: "*", resource: "*", effect: "allow" }, ...projected]
    case "acceptEdits":
      return [
        { action: "*", resource: "*", effect: "ask" },
        { action: "read", resource: "*", effect: "allow" },
        { action: "edit", resource: "*", effect: "allow" },
        ...projected,
      ]
    case "plan":
      return [
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
        { action: "glob", resource: "*", effect: "allow" },
        { action: "grep", resource: "*", effect: "allow" },
        { action: "list", resource: "*", effect: "allow" },
        ...projected,
      ]
    default:
      throw new Error(`OpenCode does not support permission mode: ${mode}`)
  }
}

function assertSafe(value: unknown, gate: AgentOutboundGate): void {
  const decoded: string[] = []
  const pending: unknown[] = [value]
  const seen = new Set<object>()
  while (pending.length) {
    const item = pending.pop()
    if (typeof item === "string") {
      const data = item.match(/^data:([^;,]*)(;[^,]*)?,([\s\S]*)$/i)
      if (
        !data ||
        !/^(?:text\/|image\/svg\+xml|application\/(?:json|xml|javascript|yaml))|\+(?:json|xml)$/i.test(
          data[1] || "text/plain"
        )
      )
        continue
      try {
        const content = decodeURIComponent(data[3])
        decoded.push(
          data[2]?.toLowerCase().includes(";base64")
            ? new TextDecoder("utf-8", { fatal: true }).decode(
                Uint8Array.from(atob(content), (byte) => byte.charCodeAt(0))
              )
            : content
        )
      } catch {
        throw new Error("OpenCode text attachment is not valid encoded text")
      }
    } else if (item && typeof item === "object" && !seen.has(item)) {
      seen.add(item)
      pending.push(...Object.values(item))
    }
  }
  if (!gate({ value, decoded }))
    throw new Error("OpenCode outbound request blocked by the PII gate")
}

interface ActiveTurn {
  controller: AbortController
  mapper: OpenCodeV2EventMapper
  requests: Map<string, AcpElicitationRequest>
  submitted: boolean
  interrupt?: Promise<unknown>
}

/** One consumer owns a turn; the persistent session channel owns later runs. */
class OpenCodeEventQueue {
  private events: ExternalAgentEvent[] = []
  private wake?: () => void
  private ended = false
  private error?: Error
  push(event: ExternalAgentEvent) {
    if (!this.ended) {
      this.events.push(event)
      this.wake?.()
    }
  }
  end(error?: Error) {
    this.ended = true
    this.error = error
    this.wake?.()
  }
  async *drain(): AsyncGenerator<ExternalAgentEvent> {
    while (!this.ended || this.events.length) {
      const event = this.events.shift()
      if (event) yield event
      else
        await new Promise<void>((resolve) => {
          this.wake = resolve
        })
    }
    if (this.error) throw this.error
  }
}
interface SessionChannel {
  controller: AbortController
  mapper: OpenCodeV2EventMapper
  listeners: Set<(event: ExternalAgentEvent) => void>
  ready: Promise<void>
  task: Promise<void>
  queue?: OpenCodeEventQueue
  running: boolean
  discarding?: boolean
  failure?: Error
}

/** What the host hands the OpenCode V2 adapter. */
export interface OpenCodeV2ClientDeps {
  /** Every REST call and the event stream go through the host's fetch. */
  fetch: AgentFetch
  /** Every outbound body, prompt, instruction and form reply passes it. */
  outboundGate: AgentOutboundGate
  /** Where the host runs this configuration's processes. */
  placement: OpenCodeV2Placement
  /** Locates the local service when no endpoint is configured. */
  discoverService: OpenCodeV2ServiceDiscovery
  /** Starts a session-owned service for gateway tasks and Cognia MCP projection. */
  launchService: OpenCodeV2ServiceLauncher
}

/** Current stable OpenCode /api contract. No V1 or beta transport fallback. */
export class OpenCodeV2ClientAdapter extends BaseProtocolAdapter {
  readonly protocol = OPENCODE_V2_PROTOCOL
  readonly semantics = OPENCODE_V2_EXECUTION_SEMANTICS
  private client?: OpenCodeClient
  private connectionService?: OpenCodeV2OwnedService
  private catalog = new Map<string, ModelInfo[]>()
  private models = new Map<string, ModelRef>()
  private commands = new Map<string, AcpAvailableCommand[]>()
  private active = new Map<string, ActiveTurn>()
  private restoredForms = new Map<string, { sessionId: string; request: AcpElicitationRequest }>()
  private connection = new AbortController()
  private owned = new Map<string, OpenCodeV2OwnedService & { client: OpenCodeClient }>()
  private mountedMcp = new Map<string, string[]>()
  private channels = new Map<string, SessionChannel>()

  private readonly fetch: AgentFetch
  private readonly outboundGate: AgentOutboundGate
  private readonly placement: OpenCodeV2Placement
  private readonly discover: OpenCodeV2ServiceDiscovery
  private readonly launchService: OpenCodeV2ServiceLauncher

  constructor(deps: OpenCodeV2ClientDeps) {
    super()
    this.fetch = deps.fetch
    this.outboundGate = deps.outboundGate
    this.placement = deps.placement
    this.discover = deps.discoverService
    this.launchService = deps.launchService
  }

  subscribeSessionEvents(
    sessionId: string,
    listener: (event: ExternalAgentEvent) => void
  ): () => void {
    const channel = this.ensureChannel(sessionId)
    channel.listeners.add(listener)
    return () => {
      channel.listeners.delete(listener)
      if (!channel.listeners.size && !channel.queue) this.stopChannel(sessionId)
    }
  }

  private stopChannel(sessionId: string): void {
    const channel = this.channels.get(sessionId)
    if (!channel) return
    channel.controller.abort()
    channel.queue?.end(new Error("OpenCode session event channel closed"))
    this.channels.delete(sessionId)
  }

  private publish(sessionId: string, event: ExternalAgentEvent): void {
    const channel = this.channels.get(sessionId)
    if (
      channel?.discarding &&
      !["session_info_update", "config_options_update", "commands_update"].includes(event.type)
    ) {
      if (event.type === "done") channel.discarding = false
      return
    }
    if (channel?.queue) {
      channel.queue.push(event)
      if (event.type === "done") {
        channel.queue.end()
        channel.queue = undefined
      }
    } else {
      for (const listener of channel?.listeners ?? []) listener(event)
    }
  }

  private ensureChannel(sessionId: string): SessionChannel {
    this.requireSession(sessionId)
    const existing = this.channels.get(sessionId)
    if (existing) {
      if (existing.failure) throw existing.failure
      return existing
    }
    let ready!: () => void
    let failed!: (error: Error) => void
    const channel: SessionChannel = {
      controller: new AbortController(),
      mapper: new OpenCodeV2EventMapper(sessionId, this.mountedMcp.get(sessionId)),
      listeners: new Set(),
      running: false,
      ready: new Promise<void>((resolve, reject) => {
        ready = resolve
        failed = reject
      }),
      task: Promise.resolve(),
    }
    void channel.ready.catch(() => undefined)
    this.channels.set(sessionId, channel)
    const client = this.getSdkClient(sessionId)
    const handshake = setTimeout(() => {
      const error = new Error("OpenCode event subscription timed out")
      channel.failure = error
      failed(error)
      channel.controller.abort(error)
    }, this._config?.timeout ?? 30000)
    channel.task = Promise.resolve().then(async () => {
      try {
        for await (const native of client.event.subscribe({ signal: channel.controller.signal })) {
          if (channel.controller.signal.aborted) break
          if (native.type === "server.connected") {
            clearTimeout(handshake)
            ready()
            continue
          }
          if (native.type === "command.updated") {
            await this.refreshSessionCommands(sessionId)
            continue
          }
          if (
            (native.data as { sessionID?: string }).sessionID !== sessionId &&
            native.type !== "form.created"
          )
            continue
          if (native.type === "session.execution.started") {
            channel.discarding = false
            channel.running = true
            this.updateSession(sessionId, { status: "executing" })
            if (!channel.queue)
              this.publish(sessionId, { type: "session_start", sessionId, timestamp: new Date() })
          }
          if (native.type === "session.model.selected") {
            this.models.set(sessionId, native.data.model)
            this.updateMetadata(sessionId)
            this.publish(sessionId, {
              type: "config_options_update",
              sessionId,
              timestamp: new Date(),
              configOptions: this.getConfigOptions(sessionId) ?? [],
            })
          }
          if (native.type === "session.renamed") {
            const session = this.requireSession(sessionId)
            session.metadata = { ...session.metadata, title: native.data.title }
          }
          for (const event of channel.mapper.map(native)) {
            if (event.type === "elicitation_request")
              this.restoredForms.set(event.request.id, { sessionId, request: event.request })
            if (event.type === "error" && event.code?.startsWith("opencode_form_")) {
              for (const formID of channel.mapper.pendingForms.keys()) {
                await client.session.form.cancel({ sessionID: sessionId, formID })
                channel.mapper.pendingForms.delete(formID)
              }
            }
            if (event.type === "done") {
              channel.running = false
              this.updateSession(sessionId, { status: "active" })
            }
            this.publish(sessionId, event)
          }
        }
        if (!channel.controller.signal.aborted)
          throw new Error("OpenCode session event stream ended")
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error))
        channel.failure = failure
        failed(failure)
        if (!channel.controller.signal.aborted) {
          const owned = Boolean(channel.queue)
          channel.queue?.end(failure)
          channel.queue = undefined
          if (channel.running)
            await client.session
              .interrupt({ sessionID: sessionId }, { signal: AbortSignal.timeout(5000) })
              .catch(() => undefined)
          if (!owned) {
            this.publish(sessionId, {
              type: "error",
              sessionId,
              timestamp: new Date(),
              error: failure.message,
              recoverable: false,
            })
            if (channel.running)
              this.publish(sessionId, {
                type: "done",
                sessionId,
                timestamp: new Date(),
                success: false,
              })
          }
          this.updateSession(sessionId, { status: "error" })
        }
      } finally {
        clearTimeout(handshake)
        failed(channel.failure ?? new Error("OpenCode event subscription closed"))
      }
    })
    return channel
  }

  async connect(config: ExternalAgentConfig): Promise<void> {
    await this.disconnect()
    this._config = config
    this._connectionStatus = "connecting"
    this.connection = new AbortController()
    try {
      assertOpenCodeV2LocalPlacement(config, this.placement)
      const explicitEndpoint = config.network?.endpoint?.trim()
      if (config.metadata?.cogniaGatewayTask) {
        this.connectionService = await this.launchService(
          config,
          [],
          config.process?.cwd,
          this.connection.signal
        )
      }
      const discovery =
        this.connectionService ??
        (explicitEndpoint ? undefined : await this.discoverService(this.connection.signal))
      const endpoint = this.connectionService?.endpoint ?? explicitEndpoint ?? discovery!.endpoint
      const url = new URL(endpoint)
      if (!["http:", "https:"].includes(url.protocol))
        throw new Error("OpenCode requires an HTTP(S) endpoint")
      const headers = new Headers(discovery?.headers)
      new Headers(config.network?.headers).forEach((value, key) => headers.set(key, value))
      const bearer = config.network?.bearerToken ?? config.network?.apiKey
      if (bearer) headers.set("Authorization", `Bearer ${bearer}`)
      const password = string(config.metadata?.serverPassword)
      if (password) {
        const login = `${string(config.metadata?.serverUsername) ?? "opencode"}:${password}`
        const bytes = new TextEncoder().encode(login)
        headers.set(
          "Authorization",
          `Basic ${btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))}`
        )
      }
      const { OpenCode } = await import("@opencode/client")
      assertOpenCodeV2LocalPlacement(config, this.placement)
      this.client = OpenCode.make({
        baseUrl: endpoint,
        headers: Object.fromEntries(headers.entries()),
        fetch: (input, init) => {
          // Apply the same policy to direct native calls, including imported
          // history, form replies, and instructions that become model context.
          if (typeof init?.body === "string") assertSafe(JSON.parse(init.body), this.outboundGate)
          return this.fetch(input, { ...init, readTimeout: 90_000 })
        },
      })
      const status = await this.client.server.info({ signal: this.connection.signal })
      if (
        !CURRENT_VERSION.test(status.version) ||
        !Number.isSafeInteger(status.pid) ||
        status.pid <= 0
      ) {
        throw new Error(`Requires current OpenCode V2; received ${status.version ?? "unknown"}`)
      }
      const probe = await this.client.session.list({ limit: 1 }, { signal: this.connection.signal })
      if (!Array.isArray(probe.data)) throw new Error("Invalid OpenCode V2 session contract")
      this._capabilities = {
        streaming: true,
        toolExecution: true,
        fileOperations: true,
        codeExecution: true,
        mcpTools: canProjectOpenCodeV2Mcp(config, this.placement),
        multiTurn: true,
        permissionModes: ["default", "acceptEdits", "bypassPermissions", "plan"],
        custom: {
          serviceVersion: status.version,
          nativeApi: "@opencode/client",
          protocol: "v2",
          shellUnsupportedReason:
            "Native shell output enters session context before Cognia can enforce output PII redaction or excludeFromContext.",
        },
      }
      this._connectionStatus = "connected"
    } catch (error) {
      await this.connectionService?.close().catch(() => undefined)
      this.connectionService = undefined
      this.client = undefined
      this._connectionStatus = "error"
      throw error
    }
  }

  async disconnect(): Promise<void> {
    const turns = [...this.active.entries()]
    for (const id of this.channels.keys()) this.stopChannel(id)
    this.connection.abort()
    for (const [, turn] of turns) turn.controller.abort()
    const outcomes = await Promise.allSettled(
      turns
        .filter(([, turn]) => turn.submitted)
        .map(([sessionID, turn]) => {
          turn.interrupt ??= this.getSdkClient(sessionID).session.interrupt(
            { sessionID },
            { signal: AbortSignal.timeout(5_000) }
          )
          return turn.interrupt
        })
    )
    const stopped = await Promise.allSettled([
      ...[...this.owned.entries()].map(async ([id, service]) => {
        await service.close()
        this.owned.delete(id)
      }),
      ...(this.connectionService
        ? [
            (async () => {
              await this.connectionService!.close()
              this.connectionService = undefined
            })(),
          ]
        : []),
    ])
    this.mountedMcp.clear()
    this.active.clear()
    this.restoredForms.clear()
    this.client = undefined
    this.catalog.clear()
    this.commands.clear()
    this.models.clear()
    this._sessions.clear()
    this._capabilities = undefined
    this._connectionStatus = "disconnected"
    const failed = [...outcomes, ...stopped].find((result) => result.status === "rejected")
    if (failed?.status === "rejected") throw failed.reason
  }

  getSdkClient(sessionId?: string): OpenCodeClient {
    if (sessionId && this.owned.has(sessionId)) return this.owned.get(sessionId)!.client
    if (!this.client) throw new Error("Not connected to OpenCode V2 service")
    return this.client
  }

  /**
   * Locate the local OpenCode V2 service through the host: the desktop asks its
   * sidecar, a host with a process table probes in-process
   * (`discoverOpenCodeV2InProcess`).
   */
  private discoverService(signal: AbortSignal) {
    return this.discover(signal)
  }

  private sessionMcpServers(options?: SessionCreateOptions) {
    const custom = options?.context?.custom as
      { mcpServers?: SessionCreateOptions["mcpServers"] } | undefined
    return options?.mcpServers ?? custom?.mcpServers ?? []
  }

  private async ownedClient(options?: SessionCreateOptions) {
    const servers = this.sessionMcpServers(options)
    if (!servers?.length && !this._config?.metadata?.cogniaGatewayTask) return undefined
    const service = await this.launchService(
      this._config!,
      servers ?? [],
      options?.cwd ?? this._config?.process?.cwd,
      this.connection.signal
    )
    try {
      const { OpenCode } = await import("@opencode/client")
      const client = OpenCode.make({
        baseUrl: service.endpoint,
        headers: service.headers,
        fetch: (input, init) => {
          if (typeof init?.body === "string") assertSafe(JSON.parse(init.body), this.outboundGate)
          return this.fetch(input, { ...init, readTimeout: 90_000 })
        },
      })
      const status = await client.server.info({ signal: this.connection.signal })
      if (
        !CURRENT_VERSION.test(status.version) ||
        !Number.isSafeInteger(status.pid) ||
        status.pid <= 0
      )
        throw new Error("Requires current OpenCode V2 for Cognia tool projection")
      return { ...service, client }
    } catch (error) {
      await service.close().catch(() => undefined)
      throw error
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!this.isConnected()) return false
    try {
      const status = await this.getSdkClient().server.info({
        signal: AbortSignal.timeout(5_000),
      })
      return CURRENT_VERSION.test(status.version)
    } catch {
      return false
    }
  }

  private requireSession(sessionId: string): ExternalAgentSession {
    const session = this._sessions.get(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    return session
  }

  private async remember(
    info: SessionInfo,
    options?: SessionCreateOptions
  ): Promise<ExternalAgentSession> {
    const session: ExternalAgentSession = {
      id: info.id,
      agentId: this._config!.id,
      status: "active",
      permissionMode: options?.permissionMode ?? this._config?.defaultPermissionMode ?? "default",
      createdAt: new Date(info.time.created),
      lastActivityAt: new Date(info.time.updated),
      messages: [],
      metadata: {
        ...info.metadata,
        title: info.title,
        directory: info.location.directory,
        cwd: info.location.directory,
        parentID: info.parentID,
        agent: info.agent,
      },
    }
    const location = { directory: info.location.directory }
    const [models, commands] = await Promise.all([
      this.getSdkClient(info.id).model.list({ location }),
      this.getSdkClient(info.id).command.list({ location }),
    ])
    this.catalog.set(
      info.id,
      models.data.filter((model) => model.enabled)
    )
    this.commands.set(
      info.id,
      commands.data.map((command) => ({
        name: command.name,
        description: command.description ?? "",
        input: { hint: "" },
        supportsDuringExecution: true,
      }))
    )
    const selectedModel =
      info.model ?? (await this.getSdkClient(info.id).model.default({ location })).data
    if (selectedModel)
      this.models.set(info.id, {
        providerID: selectedModel.providerID,
        id: selectedModel.id,
        ...("variant" in selectedModel && selectedModel.variant
          ? { variant: selectedModel.variant }
          : {}),
      })
    this._sessions.set(info.id, session)
    this.updateMetadata(info.id)
    return session
  }

  private validateSessionOptions(options?: SessionCreateOptions): void {
    if (options?.additionalDirectories?.length && !this.sessionMcpServers(options).length)
      throw new Error(
        "OpenCode V2 accepts one session location; additional workspace roots are unsupported"
      )
    assertSafe(
      {
        systemPrompt: options?.systemPrompt,
        instructionEnvelope: options?.instructionEnvelope,
        context: this.instructionContext(options),
      },
      this.outboundGate
    )
  }

  async createSession(options?: SessionCreateOptions): Promise<ExternalAgentSession> {
    this.validateSessionOptions(options)
    const directory =
      options?.cwd ??
      string(options?.metadata?.cwd) ??
      string(options?.metadata?.directory) ??
      this._config?.process?.cwd
    const mode = options?.permissionMode ?? this._config?.defaultPermissionMode ?? "default"
    const selected = string(options?.metadata?.model) ?? string(this._config?.metadata?.model)
    const owned = await this.ownedClient(options)
    const client = owned?.client ?? this.getSdkClient()
    let info: SessionInfo
    try {
      info = await client.session.create({
        ...(directory ? { location: { directory } } : {}),
        ...(selected ? { model: modelRef(selected) } : {}),
        ...(string(options?.metadata?.agent) ? { agent: string(options?.metadata?.agent) } : {}),
        permissions: permissionRules(
          mode,
          this.sessionMcpServers(options).map((server) => server.name)
        ),
      })
    } catch (error) {
      await owned?.close().catch(() => undefined)
      throw error
    }
    if (owned) {
      this.owned.set(info.id, owned)
      this.mountedMcp.set(
        info.id,
        this.sessionMcpServers(options).map((server) => server.name)
      )
    }
    try {
      const session = await this.remember(info, { ...options, permissionMode: mode })
      await this.applyInstructions(info.id, options)
      this.connection.signal.throwIfAborted()
      return session
    } catch (error) {
      this.forgetSession(info.id)
      await client.session.remove({ sessionID: info.id }).catch(() => undefined)
      this.owned.delete(info.id)
      await owned?.close().catch(() => undefined)
      throw error
    }
  }

  private instructionContext(options?: { context?: unknown }) {
    if (!options?.context) return undefined
    const { custom, ...rest } = options.context as Record<string, unknown>
    const safeCustom = custom
      ? Object.fromEntries(
          Object.entries(custom).filter(
            ([name]) => !["mcpServers", "chatSessionId", "additionalDirectories"].includes(name)
          )
        )
      : undefined
    return {
      ...rest,
      ...(safeCustom && Object.keys(safeCustom).length ? { custom: safeCustom } : {}),
    }
  }

  private async applyInstructions(
    sessionId: string,
    options?: {
      systemPrompt?: string
      instructionEnvelope?: SessionCreateOptions["instructionEnvelope"]
      context?: unknown
      briefMode?: boolean
    }
  ): Promise<void> {
    const instruction = [
      options?.systemPrompt,
      options?.instructionEnvelope?.developerInstructions,
      options?.instructionEnvelope?.customInstructions,
      options?.instructionEnvelope?.skillsSummary,
      options?.instructionEnvelope?.projectContextSummary,
      options?.context ? JSON.stringify(this.instructionContext(options)) : undefined,
      options?.briefMode ? "Keep responses concise." : undefined,
    ]
      .filter(Boolean)
      .join("\n\n")
    assertSafe(instruction, this.outboundGate)
    if (instruction)
      await this.getSdkClient(sessionId).session.instructions.entry.put({
        sessionID: sessionId,
        key: "cognia",
        value: instruction,
      })
  }

  async resumeSession(
    sessionId: string,
    options?: SessionCreateOptions
  ): Promise<ExternalAgentSession> {
    this.validateSessionOptions(options)
    if (this.owned.has(sessionId))
      throw new Error("Close the OpenCode session before resuming it with new options")
    const owned = await this.ownedClient(options)
    if (owned) this.owned.set(sessionId, owned)
    if (owned)
      this.mountedMcp.set(
        sessionId,
        this.sessionMcpServers(options).map((server) => server.name)
      )
    try {
      const info = await this.getSdkClient(sessionId).session.get({ sessionID: sessionId })
      if (options?.cwd && options.cwd !== info.location.directory)
        throw new Error("OpenCode session belongs to a different working directory")
      const session = await this.remember(info, options)
      const messages: SessionMessageInfo[] = []
      const seen = new Set<string>()
      let cursor: string | undefined
      do {
        const page = await this.getSdkClient(sessionId).message.list({
          sessionID: sessionId,
          limit: 100,
          ...(cursor ? { cursor } : { order: "asc" as const }),
        })
        messages.push(...page.data)
        cursor = page.cursor.next ?? undefined
        if (cursor && seen.has(cursor))
          throw new Error("OpenCode message pagination repeated a cursor")
        if (cursor) seen.add(cursor)
      } while (cursor)
      session.messages = mapOpenCodeV2Messages(messages)
      const [permissions, forms] = await Promise.all([
        this.getSdkClient(sessionId).permission.list({ sessionID: sessionId }),
        this.getSdkClient(sessionId).session.form.list({ sessionID: sessionId }),
      ])
      for (const [id, form] of this.restoredForms)
        if (form.sessionId === sessionId) this.restoredForms.delete(id)
      const mapper = new OpenCodeV2EventMapper(sessionId, this.mountedMcp.get(sessionId))
      const pending: ExternalAgentEvent[] = permissions.flatMap((permission) =>
        mapper.map({
          type: "permission.asked",
          id: permission.id,
          created: Date.now(),
          data: permission,
        })
      )
      for (const form of forms) {
        const events = mapper.map({
          type: "form.created",
          id: form.id,
          created: Date.now(),
          data: { form },
        })
        for (const event of events) {
          if (event.type === "elicitation_request")
            this.restoredForms.set(event.request.id, { sessionId, request: event.request })
          if (event.type === "error")
            await this.getSdkClient(sessionId).session.form.cancel({
              sessionID: sessionId,
              formID: form.id,
            })
        }
        pending.push(...events)
      }
      session.metadata = { ...session.metadata, pendingInteractions: pending }
      if (options?.permissionMode) await this.setSessionMode(sessionId, options.permissionMode)
      if (string(options?.metadata?.model))
        await this.setSessionModel(sessionId, string(options?.metadata?.model)!)
      await this.applyInstructions(sessionId, options)
      return session
    } catch (error) {
      this.forgetSession(sessionId)
      this.owned.delete(sessionId)
      await owned?.close().catch(() => undefined)
      throw error
    }
  }

  async forkSession(
    sessionId: string,
    options?: SessionCreateOptions
  ): Promise<ExternalAgentSession> {
    const target =
      options?.forkAt ??
      (options?.forkAtEntryId
        ? { kind: "entry", id: options.forkAtEntryId, boundary: "before" }
        : undefined)
    if (target && (target.kind !== "entry" || target.boundary !== "before" || !target.id.trim()))
      throw new Error("OpenCode forks support only the boundary before a message entry")
    this.validateSessionOptions(options)
    const sourceClient = this.getSdkClient(sessionId)
    const source = await sourceClient.session.get({ sessionID: sessionId })
    if (options?.cwd && source.location.directory !== options.cwd)
      throw new Error("OpenCode fork belongs to a different working directory")
    const info = await this.getSdkClient(sessionId).session.fork({
      sessionID: sessionId,
      ...(target ? { before: target.id } : {}),
    })
    try {
      return await this.resumeSession(info.id, options)
    } catch (error) {
      this.forgetSession(info.id)
      await sourceClient.session.remove({ sessionID: info.id }).catch(() => undefined)
      throw error
    }
  }

  async listSessions(options?: SessionListOptions) {
    const sessions = new Map<string, SessionInfo>()
    const seen = new Set<string>()
    let cursor: string | undefined
    do {
      const page = await this.getSdkClient().session.list({
        limit: 100,
        ...(cursor ? { cursor } : options?.cwd ? { directory: options.cwd } : {}),
      })
      for (const session of page.data) sessions.set(session.id, session)
      cursor = page.cursor.next ?? undefined
      if (cursor && seen.has(cursor))
        throw new Error("OpenCode session pagination repeated a cursor")
      if (cursor) seen.add(cursor)
    } while (cursor)
    return [...sessions.values()].map((session) => ({
      sessionId: session.id,
      cwd: session.location.directory,
      title: session.title,
      createdAt: new Date(session.time.created).toISOString(),
      updatedAt: new Date(session.time.updated).toISOString(),
    }))
  }

  private forgetSession(sessionId: string): void {
    this._sessions.delete(sessionId)
    this.models.delete(sessionId)
    this.catalog.delete(sessionId)
    this.commands.delete(sessionId)
    this.mountedMcp.delete(sessionId)
    for (const [id, form] of this.restoredForms)
      if (form.sessionId === sessionId) this.restoredForms.delete(id)
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.cancel(sessionId)
    this.stopChannel(sessionId)
    await this.owned.get(sessionId)?.close()
    this.owned.delete(sessionId)
    this.forgetSession(sessionId)
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.cancel(sessionId)
    await this.getSdkClient(sessionId).session.remove({ sessionID: sessionId })
    await this.closeSession(sessionId)
  }

  async *prompt(
    sessionId: string,
    message: ExternalAgentMessage,
    options?: ExternalAgentExecutionOptions
  ): AsyncIterable<ExternalAgentEvent> {
    this.requireSession(sessionId)
    if (options?.systemPrompt !== undefined || options?.instructionEnvelope || options?.context)
      await this.applyInstructions(sessionId, options)
    if (!promptInputPassesGate(message, this.outboundGate))
      throw new Error("OpenCode outbound prompt blocked by the PII gate")
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
    const encodeText = (value: string) =>
      btoa(
        Array.from(new TextEncoder().encode(value), (byte) => String.fromCharCode(byte)).join("")
      )
    const dataUri = (mime: string, value: string) => `data:${mime};base64,${value}`
    const files: Array<{ uri: string; name?: string }> = []
    for (const part of message.content) {
      if (part.type === "image") {
        const uri =
          part.source.type === "url"
            ? part.source.url
            : part.source.data !== undefined
              ? dataUri(part.source.mediaType, part.source.data)
              : undefined
        if (!uri) throw new Error("OpenCode image attachment has no source")
        files.push({ uri, ...(part.alt ? { name: part.alt } : {}) })
      } else if (part.type === "audio") {
        files.push({ uri: dataUri(part.mimeType, part.data) })
      } else if (part.type === "resource_link") {
        files.push({ uri: part.uri, name: part.name })
      } else if (part.type === "resource") {
        const resource = part.resource
        files.push({
          uri:
            resource.text !== undefined
              ? dataUri(resource.mimeType ?? "text/plain", encodeText(resource.text))
              : resource.blob !== undefined
                ? dataUri(resource.mimeType ?? "application/octet-stream", resource.blob)
                : resource.uri,
        })
      } else if (part.type === "file") {
        let uri: string
        if (part.content !== undefined)
          uri = dataUri(
            part.mimeType ?? "text/plain",
            part.encoding === "base64" ? part.content : encodeText(part.content)
          )
        else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(part.path)) uri = part.path
        else {
          const path = part.path.replace(/\\/g, "/")
          const directory = string(this.requireSession(sessionId).metadata?.directory)!
          const url = new URL("file:///")
          url.pathname = /^[A-Za-z]:\//.test(path)
            ? `/${path}`
            : path.startsWith("/")
              ? path
              : `${directory}/${path}`
          uri = url.toString()
        }
        files.push({ uri, name: part.path.split(/[\\/]/).at(-1) })
      } else if (part.type !== "text") {
        throw new Error(`OpenCode prompt does not accept ${part.type} content`)
      }
    }
    const input = {
      sessionID: sessionId,
      id: message.id.startsWith("msg_") ? message.id : `msg_${message.id}`,
      text,
      ...(files.length ? { files } : {}),
      delivery: "queue" as const,
    }
    assertSafe(input, this.outboundGate)
    const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/)
    const command =
      match && this.getAvailableCommands(sessionId).some((item) => item.name === match[1])
        ? match
        : undefined
    yield* this.runTurn(
      sessionId,
      (client, signal) =>
        command
          ? client.session.command(
              {
                sessionID: sessionId,
                name: command[1],
                text: command[2] ?? "",
                ...(files.length ? { files } : {}),
                delivery: "queue",
              },
              { signal }
            )
          : client.session.prompt(input, { signal }),
      options
    )
  }

  private async *runTurn(
    sessionId: string,
    submit: (client: OpenCodeClient, signal: AbortSignal) => Promise<unknown>,
    options?: ExternalAgentExecutionOptions
  ): AsyncIterable<ExternalAgentEvent> {
    if (this.channels.has(sessionId)) {
      yield* this.runObservedTurn(sessionId, submit, options)
      return
    }
    if (this.active.has(sessionId)) throw new Error("OpenCode session already has an active turn")
    const client = this.getSdkClient(sessionId)
    options?.signal?.throwIfAborted()
    if ((await client.session.active())[sessionId])
      throw new Error(
        "OpenCode session is already running; use steering or cancel it before starting a new turn"
      )
    if (this.active.has(sessionId)) throw new Error("OpenCode session already has an active turn")
    const controller = new AbortController()
    const timeoutMs = options?.timeout ?? this._config?.timeout ?? 300_000
    const timer = setTimeout(
      () => controller.abort(new Error("OpenCode turn timed out")),
      timeoutMs
    )
    const abort = () => controller.abort(options?.signal?.reason)
    options?.signal?.addEventListener("abort", abort, { once: true })
    if (options?.signal?.aborted) abort()
    const turn: ActiveTurn = {
      controller,
      mapper: new OpenCodeV2EventMapper(sessionId, this.mountedMcp.get(sessionId)),
      requests: new Map(),
      submitted: false,
    }
    this.active.set(sessionId, turn)
    this.updateSession(sessionId, { status: "executing" })
    const iterator = client.event.subscribe({ signal: controller.signal })[Symbol.asyncIterator]()
    let completed = false
    const interruptOnAbort = () => {
      if (turn.submitted && !completed) {
        turn.interrupt ??= client.session.interrupt(
          { sessionID: sessionId },
          { signal: AbortSignal.timeout(5_000) }
        )
        // Retain the rejection for awaited cleanup without an unhandled
        // rejection when an external caller has paused the generator.
        void turn.interrupt.catch(() => undefined)
      }
    }
    controller.signal.addEventListener("abort", interruptOnAbort, { once: true })
    try {
      controller.signal.throwIfAborted()
      // SSE is lazy and live-only: finish its handshake before submitting work.
      while (true) {
        const first = await iterator.next()
        controller.signal.throwIfAborted()
        if (first.done) throw new Error("OpenCode event stream closed before connecting")
        if (first.value.type === "server.connected") break
      }
      turn.submitted = true
      await submit(client, controller.signal)
      while (true) {
        const next = await iterator.next()
        controller.signal.throwIfAborted()
        if (next.done) throw new Error("OpenCode event stream ended before execution completed")
        if (next.value.type === "command.updated") await this.refreshSessionCommands(sessionId)
        if (
          next.value.type === "session.model.selected" &&
          next.value.data.sessionID === sessionId
        ) {
          this.models.set(sessionId, next.value.data.model)
          this.updateMetadata(sessionId)
          yield {
            type: "config_options_update",
            sessionId,
            timestamp: new Date(),
            configOptions: this.getConfigOptions(sessionId) ?? [],
          }
        }
        for (const event of turn.mapper.map(next.value)) {
          if (event.type === "session_info_update" && event.title !== undefined) {
            const session = this.requireSession(sessionId)
            session.metadata = { ...session.metadata, title: event.title }
          }
          if (event.type === "error" && event.code?.startsWith("opencode_form_")) {
            // A form the shared renderer cannot represent must not leave the
            // server waiting indefinitely for an answer the user cannot send.
            for (const formID of turn.mapper.pendingForms.keys()) {
              if (!turn.requests.has(formID)) {
                await client.session.form.cancel({ sessionID: sessionId, formID })
                turn.mapper.pendingForms.delete(formID)
              }
            }
          }
          if (event.type === "elicitation_request")
            turn.requests.set(event.request.id, event.request)
          if (event.type === "done") completed = true
          yield event
        }
        if (completed) break
      }
    } finally {
      clearTimeout(timer)
      options?.signal?.removeEventListener("abort", abort)
      controller.abort()
      controller.signal.removeEventListener("abort", interruptOnAbort)
      await iterator.return?.()
      this.active.delete(sessionId)
      this.updateSession(sessionId, { status: "active" })
      // Cancel the server even when the consumer stops reading the generator.
      if (turn.submitted && !completed) {
        turn.interrupt ??= client.session.interrupt(
          { sessionID: sessionId },
          { signal: AbortSignal.timeout(5_000) }
        )
        await turn.interrupt
      }
    }
  }

  private async *runObservedTurn(
    sessionId: string,
    submit: (client: OpenCodeClient, signal: AbortSignal) => Promise<unknown>,
    options?: ExternalAgentExecutionOptions
  ): AsyncIterable<ExternalAgentEvent> {
    if (this.active.has(sessionId)) throw new Error("OpenCode session already has an active turn")
    const channel = this.ensureChannel(sessionId)
    const client = this.getSdkClient(sessionId)
    const controller = new AbortController()
    const queue = new OpenCodeEventQueue()
    const turn: ActiveTurn = {
      controller,
      mapper: channel.mapper,
      requests: new Map(),
      submitted: false,
    }
    this.active.set(sessionId, turn)
    const abort = () => {
      controller.abort(options?.signal?.reason)
      queue.end(new Error("OpenCode turn cancelled"))
    }
    controller.signal.addEventListener(
      "abort",
      () => {
        queue.end(new Error("OpenCode turn cancelled"))
        if (turn.submitted) {
          channel.discarding = true
          turn.interrupt ??= client.session.interrupt(
            { sessionID: sessionId },
            { signal: AbortSignal.timeout(5000) }
          )
          void turn.interrupt.catch(() => undefined)
        }
      },
      { once: true }
    )
    options?.signal?.addEventListener("abort", abort, { once: true })
    const timer = setTimeout(abort, options?.timeout ?? this._config?.timeout ?? 300000)
    let completed = false
    try {
      if (options?.signal?.aborted) abort()
      controller.signal.throwIfAborted()
      await new Promise<void>((resolve, reject) => {
        const cancelled = () => reject(controller.signal.reason)
        controller.signal.addEventListener("abort", cancelled, { once: true })
        channel.ready
          .then(resolve, reject)
          .finally(() => controller.signal.removeEventListener("abort", cancelled))
      })
      controller.signal.throwIfAborted()
      if (
        channel.running ||
        (await client.session.active({ signal: controller.signal }))[sessionId]
      )
        throw new Error(
          "OpenCode session is already running; use steering or cancel it before starting a new turn"
        )
      controller.signal.throwIfAborted()
      channel.queue = queue
      channel.mapper.resetExecution()
      this.updateSession(sessionId, { status: "executing" })
      turn.submitted = true
      await submit(client, controller.signal)
      for await (const event of queue.drain()) {
        if (event.type === "elicitation_request") turn.requests.set(event.request.id, event.request)
        if (event.type === "done") completed = true
        yield event
      }
    } finally {
      clearTimeout(timer)
      options?.signal?.removeEventListener("abort", abort)
      if (channel.queue === queue) channel.queue = undefined
      this.active.delete(sessionId)
      if (turn.submitted && !completed) {
        channel.discarding = true
        turn.interrupt ??= client.session.interrupt(
          { sessionID: sessionId },
          { signal: AbortSignal.timeout(5000) }
        )
        await turn.interrupt
      }
      this.updateSession(sessionId, { status: channel.running ? "executing" : "active" })
      if (!channel.listeners.size) this.stopChannel(sessionId)
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const turn = this.active.get(sessionId)
    if (turn) {
      turn.controller.abort()
      if (turn.submitted) {
        turn.interrupt ??= this.getSdkClient(sessionId).session.interrupt(
          { sessionID: sessionId },
          { signal: AbortSignal.timeout(5_000) }
        )
        await turn.interrupt.catch((error: unknown) => {
          if (!isSessionNotFound(error)) throw error
        })
      }
      return
    }
    if (this.client)
      await this.getSdkClient(sessionId)
        .session.interrupt({ sessionID: sessionId })
        .catch((error: unknown) => {
          if (!isSessionNotFound(error)) throw error
        })
  }

  async steerTurn(sessionId: string, text: string): Promise<void> {
    if (!this.active.get(sessionId)?.submitted)
      throw new Error("OpenCode session has no active turn")
    assertSafe(text, this.outboundGate)
    await this.getSdkClient(sessionId).session.prompt({
      sessionID: sessionId,
      text,
      delivery: "steer",
    })
  }

  async respondToPermission(sessionId: string, response: AcpPermissionResponse): Promise<void> {
    this.requireSession(sessionId)
    assertSafe(response.reason, this.outboundGate)
    await this.getSdkClient(sessionId).permission.reply({
      sessionID: sessionId,
      requestID: response.requestId,
      decision: response.granted
        ? response.rememberChoice || response.scope === "always"
          ? "always"
          : "once"
        : "reject",
      ...(response.reason ? { message: response.reason } : {}),
    })
    this.removePendingInteraction(sessionId, response.requestId, !response.granted)
  }

  private removePendingInteraction(
    sessionId: string,
    requestId: string,
    rejectPermissions = false
  ): void {
    const session = this.requireSession(sessionId)
    const pending = session.metadata?.pendingInteractions as ExternalAgentEvent[] | undefined
    if (pending)
      session.metadata = {
        ...session.metadata,
        pendingInteractions: pending.filter(
          (event) =>
            (event.type !== "permission_request" && event.type !== "elicitation_request") ||
            (!(rejectPermissions && event.type === "permission_request") &&
              event.request.id !== requestId)
        ),
      }
  }

  async respondToElicitation(response: AcpElicitationResponse): Promise<void> {
    const entry = [...this.active.entries()].find(([, turn]) =>
      turn.requests.has(response.requestId)
    )
    const restored = this.restoredForms.get(response.requestId)
    const sessionId = entry?.[0] ?? restored?.sessionId
    const request = entry?.[1].requests.get(response.requestId) ?? restored?.request
    if (!sessionId || !request) throw new Error(`Unknown OpenCode form: ${response.requestId}`)
    const answer = validateAcpElicitationResponse(request, response)
    if (answer.action === "accept" && request.mode === "form") {
      for (const [key, value] of Object.entries(answer.content ?? {})) {
        const property = request.requestedSchema!.properties[key]
        const fail = () => {
          throw new Error(`Invalid OpenCode form field: ${key}`)
        }
        if (typeof value === "number") {
          if (typeof property.minimum === "number" && value < property.minimum) fail()
          if (typeof property.maximum === "number" && value > property.maximum) fail()
        }
        if (typeof value === "string") {
          const length = Array.from(value).length
          if (typeof property.minLength === "number" && length < property.minLength) fail()
          if (typeof property.maxLength === "number" && length > property.maxLength) fail()
          if (
            typeof property.pattern === "string" &&
            !new RegExp(property.pattern, "u").test(value)
          )
            fail()
        }
        if (Array.isArray(value)) {
          if (typeof property.minItems === "number" && value.length < property.minItems) fail()
          if (typeof property.maxItems === "number" && value.length > property.maxItems) fail()
          const allowed = property.items?.enum ?? property.items?.oneOf?.map((item) => item.const)
          if (allowed && value.some((item) => !allowed.includes(item))) fail()
        }
      }
    }
    assertSafe(answer.content, this.outboundGate)
    const formID =
      string(request.raw.openCodeForm && (request.raw.openCodeForm as { id?: string }).id) ??
      response.requestId
    if (answer.action === "accept")
      await this.getSdkClient(sessionId).session.form.reply({
        sessionID: sessionId,
        formID,
        answer: answer.content ?? {},
      })
    else await this.getSdkClient(sessionId).session.form.cancel({ sessionID: sessionId, formID })
    entry?.[1].requests.delete(response.requestId)
    entry?.[1].mapper.pendingForms.delete(formID)
    this.channels.get(sessionId)?.mapper.pendingForms.delete(formID)
    this.restoredForms.delete(response.requestId)
    this.removePendingInteraction(sessionId, response.requestId)
  }

  async setSessionMode(sessionId: string, mode: AcpPermissionMode): Promise<void> {
    this.requireSession(sessionId)
    await this.getSdkClient(sessionId).session.update({
      sessionID: sessionId,
      permissions: permissionRules(mode, this.mountedMcp.get(sessionId)),
    })
    this.updateSession(sessionId, { permissionMode: mode })
  }

  private updateMetadata(sessionId: string): void {
    const session = this.requireSession(sessionId)
    session.metadata = {
      ...session.metadata,
      availableCommands: this.getAvailableCommands(sessionId),
      models: this.getSessionModels(sessionId),
      configOptions: this.getConfigOptions(sessionId),
    }
  }

  getSessionModels(sessionId: string): AcpSessionModelState | undefined {
    const available = this.catalog.get(sessionId)
    if (!available) return undefined
    const model = this.models.get(sessionId)
    return {
      currentModelId: model ? `${model.providerID}/${model.id}` : "",
      availableModels: available.map((model) => ({
        modelId: `${model.providerID}/${model.id}`,
        name: model.name,
      })),
    }
  }

  async setSessionModel(sessionId: string, value: string): Promise<void> {
    this.requireSession(sessionId)
    const model = modelRef(value)
    await this.getSdkClient(sessionId).session.switchModel({ sessionID: sessionId, model })
    this.models.set(sessionId, model)
    this.updateMetadata(sessionId)
  }

  getConfigOptions(sessionId: string): AcpConfigOption[] | undefined {
    if (!this._sessions.has(sessionId)) return undefined
    const model = this.models.get(sessionId)
    const variants =
      this.catalog
        .get(sessionId)
        ?.find((entry) => entry.id === model?.id && entry.providerID === model.providerID)
        ?.variants ?? []
    if (!variants.length) return []
    return [
      {
        id: "variant",
        name: "Model variant",
        category: "thought_level",
        type: "select",
        currentValue: model?.variant ?? NO_VARIANT,
        options: [
          { value: NO_VARIANT, name: "Base model" },
          ...variants.map((variant) => ({ value: variant.id, name: variant.id })),
        ],
      },
    ]
  }

  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string | boolean
  ): Promise<AcpConfigOption[]> {
    this.requireSession(sessionId)
    const option = this.getConfigOptions(sessionId)?.find((option) => option.id === configId)
    const model = this.models.get(sessionId)
    if (
      !option ||
      option.type !== "select" ||
      !model ||
      typeof value !== "string" ||
      !option.options.some((item) => "value" in item && item.value === value)
    )
      throw new Error("Invalid OpenCode model variant")
    const next = {
      providerID: model.providerID,
      id: model.id,
      ...(value !== NO_VARIANT ? { variant: value } : {}),
    }
    await this.getSdkClient(sessionId).session.switchModel({ sessionID: sessionId, model: next })
    this.models.set(sessionId, next)
    this.updateMetadata(sessionId)
    return this.getConfigOptions(sessionId) ?? []
  }

  getAvailableCommands(sessionId?: string): AcpAvailableCommand[] {
    return sessionId
      ? [...(this.commands.get(sessionId) ?? [])]
      : [...this.commands.values()].flat()
  }

  async getSessionOperationCapabilities(): Promise<
    Partial<ExternalAgentSessionOperationCapabilities>
  > {
    // Shell endpoints persist raw output into provider context and offer no
    // output-redaction hook; the governed Cognia tool host remains the route.
    return {
      forkAtEntry: "supported",
      backgroundTurns: "supported",
      shell: "unsupported",
      abortShell: "unsupported",
    }
  }

  async refreshSessionCommands(sessionId: string): Promise<AcpAvailableCommand[]> {
    const session = this.requireSession(sessionId)
    const response = await this.getSdkClient(sessionId).command.list({
      location: { directory: String(session.metadata?.directory) },
    })
    const commands = response.data.map((command) => ({
      name: command.name,
      description: command.description ?? "",
      input: { hint: "" },
      supportsDuringExecution: true,
    }))
    this.commands.set(sessionId, commands)
    this.updateMetadata(sessionId)
    this.publish(sessionId, { type: "commands_update", sessionId, timestamp: new Date(), commands })
    return commands
  }

  async executeSessionCommand(
    sessionId: string,
    command: string
  ): Promise<ExternalAgentSessionInputAcceptance> {
    assertSafe(command, this.outboundGate)
    const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(command)
    if (!match || !this.getAvailableCommands(sessionId).some((item) => item.name === match[1]))
      throw new Error("Unknown OpenCode command")
    if (!this.channels.get(sessionId)?.listeners.size && !this.active.has(sessionId))
      throw new Error("OpenCode commands require a session event subscriber")
    const channel = this.ensureChannel(sessionId)
    await channel.ready
    await this.getSdkClient(sessionId).session.command({
      sessionID: sessionId,
      name: match[1],
      text: match[2] ?? "",
      delivery: "queue",
    })
    return { disposition: "handled", mode: "follow_up" }
  }

  async enqueueSessionInput(
    sessionId: string,
    input: ExternalAgentSessionInput,
    mode: ExternalAgentSessionInputMode
  ): Promise<ExternalAgentSessionInputAcceptance> {
    if (mode !== "steer" && mode !== "follow_up") throw new Error("Unknown OpenCode input mode")
    const files = input.images?.map((image) => ({
      uri: `data:${image.mimeType};base64,${image.data}`,
    }))
    const payload = {
      sessionID: sessionId,
      text: input.text,
      ...(files?.length ? { files } : {}),
      delivery: mode === "steer" ? ("steer" as const) : ("queue" as const),
    }
    assertSafe(payload, this.outboundGate)
    const channel = this.channels.get(sessionId)
    if (!this.active.has(sessionId) && !(channel?.running && channel.listeners.size))
      throw new Error("OpenCode queued input requires an active turn")
    await this.getSdkClient(sessionId).session.prompt(payload)
    return { disposition: "queued", mode }
  }

  async clearSessionInputQueue(sessionId: string): Promise<ExternalAgentSessionInputQueue> {
    const client = this.getSdkClient(sessionId)
    const items = (await client.session.inbox.list({ sessionID: sessionId })).filter(
      (item) => item.type === "user"
    )
    const inputs = items.map((item) => {
      if (
        item.payload.agents?.length ||
        item.payload.skills?.length ||
        item.payload.files?.some((file) => !file.mime.startsWith("image/"))
      )
        throw new Error(
          "OpenCode queued input contains attachments that cannot be restored by this client"
        )
      return {
        text: item.payload.text,
        ...(item.payload.files?.length
          ? { images: item.payload.files.map((file) => ({ data: file.data, mimeType: file.mime })) }
          : {}),
      }
    })
    const queue: ExternalAgentSessionInputQueue = { steering: [], followUp: [] }
    for (let index = 0; index < items.length; index++) {
      try {
        await client.session.inbox.cancel({ sessionID: sessionId, inboxID: items[index].id })
        queue[items[index].delivery === "steer" ? "steering" : "followUp"].push(inputs[index])
      } catch (error) {
        // Preserve every input whose cancellation succeeded even if a later
        // cancellation races consumption or the connection becomes unavailable.
        this.publish(sessionId, {
          type: "error",
          sessionId,
          timestamp: new Date(),
          error: error instanceof Error ? error.message : String(error),
          recoverable: true,
        })
        break
      }
    }
    return queue
  }

  async renameSession(sessionId: string, name: string): Promise<void> {
    assertSafe(name, this.outboundGate)
    if (!name.trim()) throw new Error("OpenCode session title cannot be empty")
    await this.getSdkClient(sessionId).session.update({ sessionID: sessionId, title: name })
    const session = this.requireSession(sessionId)
    session.metadata = { ...session.metadata, title: name }
    this.publish(sessionId, {
      type: "session_info_update",
      sessionId,
      timestamp: new Date(),
      title: name,
    })
  }

  async getSessionEntries(sessionId: string, since?: string): Promise<ExternalAgentSessionEntry[]> {
    const entries: ExternalAgentSessionEntry[] = []
    const seen = new Set<string>()
    let cursor: string | undefined
    let found = since === undefined
    let parentId: string | null = null
    do {
      const page = await this.getSdkClient(sessionId).message.list({
        sessionID: sessionId,
        limit: 100,
        ...(cursor ? { cursor } : { order: "asc" as const }),
      })
      for (const message of mapOpenCodeV2Messages(page.data)) {
        const { metadata: _metadata, ...normalized } = message
        if (found)
          entries.push({
            id: message.id,
            parentId,
            type: "message",
            timestamp: message.timestamp.toISOString(),
            message: normalized,
            forkAt: { kind: "entry", id: message.id, boundary: "before" },
          })
        if (message.id === since) found = true
        parentId = message.id
      }
      cursor = page.cursor.next ?? undefined
      if (cursor && seen.has(cursor))
        throw new Error("OpenCode message pagination repeated a cursor")
      if (cursor) seen.add(cursor)
    } while (cursor)
    if (!found) throw new Error("OpenCode history cursor was not found")
    return entries
  }

  getSessionExtensionSupport() {
    const supported = { state: "supported" as const }
    return { "session/list": supported, "session/fork": supported, "session/resume": supported }
  }

  async getCompactionCapability(sessionId: string): Promise<ExternalAgentCompactionCapability> {
    if (!this._sessions.has(sessionId))
      return { status: "unknown", routes: [], reason: "session_not_found" }
    return { status: "supported", routes: [{ kind: "native", supportsFocus: false }] }
  }

  async compactSession(
    sessionId: string,
    options: ExternalAgentCompactionOptions = {}
  ): Promise<void> {
    this.requireSession(sessionId)
    if (options.focus)
      throw new Error("OpenCode native compaction does not accept focus instructions")
    for await (const event of this.runTurn(sessionId, (client, signal) =>
      client.session.compact({ sessionID: sessionId, delivery: "queue" }, { signal })
    )) {
      if (event.type === "error") throw new Error(event.error)
      if (event.type === "done" && !event.success) throw new Error("OpenCode compaction failed")
    }
  }

  getProviderUndoCapability(sessionId: string) {
    return this.getAdvertisedProviderUndoCapability(sessionId)
  }
  undoLastProviderChange(sessionId: string) {
    return this.undoWithAdvertisedCommand(sessionId)
  }
}

/** The OpenCode V2 service client and its full native API, for the UI. */
export const openCodeV2Extension = defineAdapterExtension<OpenCodeV2ClientAdapter>(
  "opencode.v2-service",
  (adapter) => (adapter instanceof OpenCodeV2ClientAdapter ? adapter : undefined)
)
