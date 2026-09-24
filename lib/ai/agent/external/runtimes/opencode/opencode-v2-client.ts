import type {
  OpenCodeClient,
  ModelInfo,
  ModelRef,
  SessionInfo,
  SessionMessageInfo,
  PermissionRuleset,
} from "@opencode/client"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import {
  discoverOpenCodeV2ViaSidecar,
  validateOpenCodeV2Discovery,
  type OpenCodeV2Discovery,
} from "@/lib/claude/feature-call"
import { isCliHost } from "@/lib/platform/detect"
import { platformStreamingFetch } from "@/lib/network/platform-streaming-fetch"
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
} from "@/types/agent/external-agent"
import {
  BaseProtocolAdapter,
  type SessionCreateOptions,
  type SessionListOptions,
} from "../../protocol-adapter"
import { hasNoLeakingExternalAgentPromptInput } from "../../policy/outbound-prompt-pii"
import { validateAcpElicitationResponse } from "../acp/acp-elicitation"
import { OpenCodeV2EventMapper, mapOpenCodeV2Messages } from "./opencode-v2-events"
import {
  canProjectOpenCodeV2Mcp,
  launchOpenCodeV2Service,
  type OpenCodeV2OwnedService,
} from "./opencode-v2-launcher"
import type {
  ExternalAgentCompactionCapability,
  ExternalAgentCompactionOptions,
} from "../../capability/session-capabilities"

const NO_VARIANT = "#none"
const CURRENT_VERSION = /^2\.\d+\.\d+(?:\+[\w.-]+)?$/

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

function assertSafe(value: unknown): void {
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
  if (!hasNoLeakingPiiDeep({ value, decoded }))
    throw new Error("OpenCode outbound request blocked by the PII gate")
}

interface ActiveTurn {
  controller: AbortController
  mapper: OpenCodeV2EventMapper
  requests: Map<string, AcpElicitationRequest>
  submitted: boolean
  interrupt?: Promise<unknown>
}

/** Current stable OpenCode /api contract. No V1 or beta transport fallback. */
export class OpenCodeV2ClientAdapter extends BaseProtocolAdapter {
  readonly protocol = "opencode-v2"
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

  constructor(private readonly launchService = launchOpenCodeV2Service) {
    super()
  }

  async connect(config: ExternalAgentConfig): Promise<void> {
    await this.disconnect()
    this._config = config
    this._connectionStatus = "connecting"
    this.connection = new AbortController()
    try {
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
      this.client = OpenCode.make({
        baseUrl: endpoint,
        headers: Object.fromEntries(headers.entries()),
        fetch: (input, init) => {
          // Apply the same policy to direct native calls, including imported
          // history, form replies, and instructions that become model context.
          if (typeof init?.body === "string") assertSafe(JSON.parse(init.body))
          return platformStreamingFetch(input, { ...init, readTimeout: 90_000 })
        },
      })
      const status = await this.client.server.status({ signal: this.connection.signal })
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
        mcpTools: canProjectOpenCodeV2Mcp(config),
        multiTurn: true,
        permissionModes: ["default", "acceptEdits", "bypassPermissions", "plan"],
        custom: { serviceVersion: status.version, nativeApi: "@opencode/client", protocol: "v2" },
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
   * Locate the local OpenCode V2 service.
   *
   * The desktop delegates discovery to its sidecar because the renderer has no
   * process table; the standalone CLI owns one and has no feature-call bridge,
   * so it runs the identical `Service.discover` + `/api/status` probe
   * in-process (the same contract `sidecar/dispatch/feature-call.mjs` serves).
   */
  private async discoverService(signal: AbortSignal): Promise<OpenCodeV2Discovery> {
    if (!isCliHost()) return discoverOpenCodeV2ViaSidecar(signal)
    const { Service } = await import("@opencode/client/service")
    signal.throwIfAborted()
    const endpoint = await Service.discover({
      version: (version) => CURRENT_VERSION.test(version),
    })
    signal.throwIfAborted()
    if (!endpoint)
      throw new Error(
        "No compatible OpenCode V2 service was discovered. Start one with `opencode service start`."
      )
    const url = new URL(endpoint.url)
    if (!["http:", "https:"].includes(url.protocol))
      throw new Error("OpenCode V2 discovery returned a non-HTTP endpoint")
    const headers = Object.fromEntries(
      Object.entries(Service.headers(endpoint) ?? {}).filter(
        ([name, value]) => name.trim() && typeof value === "string"
      )
    )
    const probe = await platformStreamingFetch(new URL("/api/status", url), {
      headers,
      signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
    })
    const status = (await probe.json().catch(() => undefined)) as
      { version?: string; pid?: number } | undefined
    signal.throwIfAborted()
    if (!probe.ok) throw new Error("OpenCode V2 discovery health probe failed")
    if (
      !status?.version ||
      !CURRENT_VERSION.test(status.version) ||
      typeof status.pid !== "number" ||
      !Number.isInteger(status.pid) ||
      status.pid <= 0
    )
      throw new Error("OpenCode V2 discovery returned an incompatible health contract")
    return validateOpenCodeV2Discovery({
      endpoint: url.toString().replace(/\/$/, ""),
      version: status.version,
      headers,
    })
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
          if (typeof init?.body === "string") assertSafe(JSON.parse(init.body))
          return platformStreamingFetch(input, { ...init, readTimeout: 90_000 })
        },
      })
      const status = await client.server.status({ signal: this.connection.signal })
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
      const status = await this.getSdkClient().server.status({
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
        input: { hint: "arguments" },
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
    assertSafe({
      systemPrompt: options?.systemPrompt,
      instructionEnvelope: options?.instructionEnvelope,
      context: this.instructionContext(options),
    })
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
    assertSafe(instruction)
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
    this.validateSessionOptions(options)
    const sourceClient = this.getSdkClient(sessionId)
    const source = await sourceClient.session.get({ sessionID: sessionId })
    if (options?.cwd && source.location.directory !== options.cwd)
      throw new Error("OpenCode fork belongs to a different working directory")
    const info = await this.getSdkClient(sessionId).session.fork({ sessionID: sessionId })
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
    if (!hasNoLeakingExternalAgentPromptInput(message))
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
    assertSafe(input)
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
        for (const event of turn.mapper.map(next.value)) {
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
    assertSafe(text)
    await this.getSdkClient(sessionId).session.prompt({
      sessionID: sessionId,
      text,
      delivery: "steer",
    })
  }

  async respondToPermission(sessionId: string, response: AcpPermissionResponse): Promise<void> {
    this.requireSession(sessionId)
    assertSafe(response.reason)
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
    assertSafe(answer.content)
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
