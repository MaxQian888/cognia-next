import type { OpencodeClient, SessionV2Info } from "@opencode-ai/sdk/v2/client"
import { hasNoLeakingPiiDeep } from "@cognia/redact"

import { discoverOpenCodeV2ViaSidecar } from "@/lib/claude/feature-call"
import type {
  AcpAvailableCommand,
  AcpConfigOption,
  AcpPermissionResponse,
  AcpSessionModelState,
  ExternalAgentConfig,
  ExternalAgentEvent,
  ExternalAgentExecutionOptions,
  ExternalAgentMessage,
  ExternalAgentSession,
  ExternalAgentTokenUsage,
} from "@/types/agent/external-agent"
import { BaseProtocolAdapter, type SessionCreateOptions } from "./protocol-adapter"
import { buildOpenCodeFileParts, hasNoLeakingOpenCodePromptInput } from "./opencode-client"
import {
  isExplicitlyUnsupportedCapabilityError,
  type ExternalAgentCompactionCapability,
  type ExternalAgentCompactionOptions,
} from "./session-capabilities"

const PINNED_PREVIEW_SERVICE_VERSION = "2.0.0-beta.1"

type SdkResult<T> = {
  data?: T
  error?: unknown
  response?: { status?: number }
}

type OpenCodeV2Health = {
  healthy?: boolean
  version?: string
  pid?: number
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function sdkError(result: SdkResult<unknown>): Error {
  const error = readRecord(result.error)
  const message =
    readString(error?.message) ??
    readString(error?._tag) ??
    (typeof result.error === "string" ? result.error : "OpenCode V2 request failed")
  return Object.assign(new Error(message), {
    status: result.response?.status,
    code: error?.code ?? error?._tag,
  })
}

function unwrap<T>(result: SdkResult<T>): T {
  if (result.error !== undefined) throw sdkError(result)
  return result.data as T
}

function nestedData<T>(result: SdkResult<unknown>): T {
  const outer = unwrap(result) as Record<string, unknown>
  return outer.data as T
}

function eventResult(value: unknown): string | Record<string, unknown> {
  const direct = readString(value) ?? readRecord(value)
  if (direct !== undefined) return direct
  if (value === undefined || value === null) return ""
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function eventTime(data: Record<string, unknown> | undefined): Date {
  const value = data?.timestamp
  return typeof value === "number" ? toDate(value) : new Date()
}

function toDate(value: number | undefined): Date {
  if (!value) return new Date()
  return new Date(value < 10_000_000_000 ? value * 1000 : value)
}

function isHealthyService(health: OpenCodeV2Health): boolean {
  return (
    health.healthy === true ||
    (typeof health.version === "string" &&
      health.version.length > 0 &&
      typeof health.pid === "number")
  )
}

function messageText(message: ExternalAgentMessage): string {
  return (message.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => ("text" in part ? part.text : ""))
    .join("\n")
}

function stepTokenUsage(data: Record<string, unknown> | undefined): ExternalAgentTokenUsage {
  const tokens = readRecord(data?.tokens)
  const cache = readRecord(tokens?.cache)
  const input = typeof tokens?.input === "number" ? tokens.input : 0
  const output = typeof tokens?.output === "number" ? tokens.output : 0
  const reasoning = typeof tokens?.reasoning === "number" ? tokens.reasoning : 0
  return {
    promptTokens: input,
    completionTokens: output,
    totalTokens: input + output + reasoning,
    cacheReadTokens: typeof cache?.read === "number" ? cache.read : undefined,
    cacheWriteTokens: typeof cache?.write === "number" ? cache.write : undefined,
  }
}

/**
 * The config-option id the variant picker is exposed under.
 *
 * OpenCode has no reasoning-LEVEL control. What it has is variants: its docs
 * call them "named request overlays for one model, commonly used for reasoning
 * effort or token budgets", selected per session as the `#variant` half of a
 * `provider/model#variant` reference. So the honest control is a picker over
 * THIS model's variants, not a low/medium/high slider whose tiers OpenCode
 * never defined.
 */
const VARIANT_OPTION_ID = "variant"

/**
 * The "no overlay" choice — the base model with none of its variants applied.
 *
 * It cannot collide with a real variant id: OpenCode parses a model reference
 * by splitting on the first `#`, so everything after it is the id and a `#`
 * can never appear inside one. An empty string would have been the obvious
 * sentinel, but Radix rejects `value=""` on a select item, and the picker this
 * feeds is a Radix select.
 */
const NO_VARIANT = "#none"

export class OpenCodeV2ClientAdapter extends BaseProtocolAdapter {
  readonly protocol = "opencode-v2"

  private client?: OpencodeClient
  private commands: AcpAvailableCommand[] = []
  private models = new Map<string, AcpSessionModelState>()
  /**
   * Variant ids per `provider/model`, from `v2.model.list()`.
   *
   * Kept because a variant is only meaningful against the model that declares
   * it, and OpenCode does not fall back: its docs warn that "an unknown variant
   * fails model resolution instead of silently using the base model". Offering
   * or forwarding one we did not read back from the catalog would turn a picker
   * into a way to break the next turn.
   */
  private modelVariants = new Map<string, string[]>()
  /** The variant each session currently runs under, absent when it is on base. */
  private sessionVariants = new Map<string, string>()
  private nativeCompactionUnsupported = false

  async connect(config: ExternalAgentConfig): Promise<void> {
    this._config = config
    this._connectionStatus = "connecting"
    this.nativeCompactionUnsupported = false
    try {
      const discovery = await discoverOpenCodeV2ViaSidecar()
      if (discovery.version !== PINNED_PREVIEW_SERVICE_VERSION) {
        throw new Error(
          `Incompatible OpenCode V2 service ${discovery.version}; Cognia's pinned preview contract requires ${PINNED_PREVIEW_SERVICE_VERSION}. Current OpenCode V2 builds use a different protocol surface.`
        )
      }
      const { createOpencodeClient } = await import("@opencode-ai/sdk/v2/client")
      this.client = createOpencodeClient({
        baseUrl: discovery.endpoint,
        headers: discovery.headers,
      })

      const health = unwrap<OpenCodeV2Health>(await this.client.v2.health.get())
      if (!isHealthyService(health)) {
        throw new Error("OpenCode V2 service health probe failed")
      }
      const sessionProbe = unwrap<Record<string, unknown>>(
        await this.client.v2.session.list({ limit: 1 })
      )
      if (!Array.isArray(sessionProbe.data)) {
        throw new Error("OpenCode service does not expose the expected V2 session contract")
      }

      await this.discoverCapabilities()
      this._capabilities = {
        streaming: true,
        toolExecution: true,
        fileOperations: false,
        codeExecution: true,
        mcpTools: false,
        multiTurn: true,
        permissionModes: ["default", "acceptEdits", "bypassPermissions", "plan"],
        custom: {
          preview: true,
          serviceVersion: discovery.version,
          surfaceSupport: {
            pty: "unsupported",
            tui: "unsupported",
            mcp: "unsupported",
            file: "unsupported",
            find: "unsupported",
            providerManagement: "unsupported",
          },
        },
      }
      this._connectionStatus = "connected"
    } catch (error) {
      this.client = undefined
      this._connectionStatus = "error"
      throw error
    }
  }

  async disconnect(): Promise<void> {
    this.client = undefined
    this.commands = []
    this.models.clear()
    this.modelVariants.clear()
    this.sessionVariants.clear()
    this._sessions.clear()
    this._connectionStatus = "disconnected"
  }

  async healthCheck(): Promise<boolean> {
    if (!this.client || !this.isConnected()) return false
    try {
      return isHealthyService(unwrap<OpenCodeV2Health>(await this.client.v2.health.get()))
    } catch {
      return false
    }
  }

  async createSession(options?: SessionCreateOptions): Promise<ExternalAgentSession> {
    const client = this.requireClient()
    const directory =
      readString(options?.cwd) ??
      readString(options?.metadata?.cwd) ??
      readString(options?.metadata?.directory)
    const info = nestedData<SessionV2Info>(
      await client.v2.session.create({
        location: directory ? { directory } : undefined,
      })
    )
    const session = this.mapSession(info)
    this._sessions.set(session.id, session)
    this.attachRuntimeMetadata(session)
    return session
  }

  async listSessions(): Promise<
    Array<{ sessionId: string; title?: string; createdAt?: string; updatedAt?: string }>
  > {
    const result = unwrap<Record<string, unknown>>(await this.requireClient().v2.session.list())
    const sessions = Array.isArray(result.data) ? (result.data as SessionV2Info[]) : []
    return sessions.map((session) => ({
      sessionId: session.id,
      title: session.title,
      createdAt: toDate(session.time?.created).toISOString(),
      updatedAt: toDate(session.time?.updated).toISOString(),
    }))
  }

  async resumeSession(sessionId: string): Promise<ExternalAgentSession> {
    const info = nestedData<SessionV2Info>(
      await this.requireClient().v2.session.get({ sessionID: sessionId })
    )
    const session = this.mapSession(info)
    this._sessions.set(session.id, session)
    this.attachRuntimeMetadata(session)
    return session
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.cancel(sessionId)
    this._sessions.delete(sessionId)
    this.models.delete(sessionId)
    this.sessionVariants.delete(sessionId)
  }

  async *prompt(
    sessionId: string,
    message: ExternalAgentMessage,
    options?: ExternalAgentExecutionOptions
  ): AsyncIterable<ExternalAgentEvent> {
    const client = this.requireClient()
    const session = this._sessions.get(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    this.updateSession(sessionId, { status: "executing" })

    if (!hasNoLeakingOpenCodePromptInput(message)) {
      this.updateSession(sessionId, { status: "active" })
      throw new Error("OpenCode V2 outbound prompt blocked by the PII gate")
    }

    const files = buildOpenCodeFileParts(message.content).map((file) => ({
      uri: file.url,
      ...(file.filename ? { name: file.filename } : {}),
    }))
    const prompt = {
      text: messageText(message),
      ...(files.length > 0 ? { files } : {}),
    }
    if (!hasNoLeakingPiiDeep(prompt)) {
      this.updateSession(sessionId, { status: "active" })
      throw new Error("OpenCode V2 outbound prompt blocked by the PII gate")
    }

    const subscription = await client.v2.session.events({ sessionID: sessionId })
    const stream = subscription.stream
    const onAbort = () => void this.cancel(sessionId)
    options?.signal?.addEventListener("abort", onAbort, { once: true })
    try {
      unwrap(
        await client.v2.session.prompt(
          {
            sessionID: sessionId,
            id: message.id,
            prompt,
            delivery: "queue",
          },
          options?.signal ? { signal: options.signal } : undefined
        )
      )
      const iterator = stream[Symbol.asyncIterator]()
      let completion: Promise<{ kind: "complete" }> | undefined
      let tokenUsage: ExternalAgentTokenUsage | undefined
      let terminalEventEmitted = false
      const waitForIdle = () => {
        completion ??= (async () => {
          unwrap(await client.v2.session.wait({ sessionID: sessionId }))
          return { kind: "complete" as const }
        })()
        return completion
      }

      try {
        while (true) {
          const nextEvent = iterator.next().then((result) => ({ kind: "event" as const, result }))
          const next = completion ? await Promise.race([nextEvent, completion]) : await nextEvent
          if (next.kind === "complete") break
          if (next.result.done) {
            await waitForIdle()
            break
          }

          const raw = next.result.value
          const event = readRecord(raw)
          const eventType = readString(event?.type)
          const eventData = readRecord(event?.properties) ?? readRecord(event?.data)
          if (eventType === "session.next.step.ended") {
            tokenUsage = stepTokenUsage(eventData)
            void waitForIdle()
            continue
          }

          const mapped = this.mapEvent(sessionId, raw)
          for (const event of mapped) yield event
          if (mapped.some((event) => event.type === "done")) {
            terminalEventEmitted = true
            break
          }
        }
      } finally {
        await iterator.return?.()
      }
      if (!terminalEventEmitted) {
        yield {
          type: "done",
          sessionId,
          timestamp: new Date(),
          success: true,
          stopReason: "end_turn",
          ...(tokenUsage ? { tokenUsage } : {}),
        }
      }
    } finally {
      options?.signal?.removeEventListener("abort", onAbort)
      this.updateSession(sessionId, { status: "active" })
    }
  }

  async cancel(sessionId: string): Promise<void> {
    if (!this.client) return
    unwrap(await this.client.v2.session.interrupt({ sessionID: sessionId }))
  }

  async respondToPermission(sessionId: string, response: AcpPermissionResponse): Promise<void> {
    const reply = response.granted
      ? response.rememberChoice || response.scope === "always"
        ? "always"
        : "once"
      : "reject"
    unwrap(
      await this.requireClient().v2.session.permission.reply({
        sessionID: sessionId,
        requestID: response.requestId,
        reply,
        message: response.reason,
      })
    )
  }

  async setSessionModel(sessionId: string, modelId: string): Promise<void> {
    // Switching models drops the variant. Variants are declared per model, and
    // OpenCode fails model resolution on an unknown one rather than ignoring
    // it — so carrying the old model's overlay across would not degrade to the
    // base model, it would break the next turn.
    await this.switchModel(sessionId, modelId, undefined)
  }

  getSessionModels(sessionId: string): AcpSessionModelState | undefined {
    return this.models.get(sessionId)
  }

  // --------------------------------------------------------------------------
  // Session config options (synthesized — model variant)
  //
  // OpenCode V2 has no ACP-style config-option surface, so this synthesizes one
  // the same way the Codex adapter synthesizes its reasoning-effort picker: the
  // existing session panel renders it with no new chat UI. The value it writes
  // is real — it rides `v2.session.switchModel` as the `variant` half of the
  // model reference, which is the channel OpenCode's own `provider/model#variant`
  // syntax names.
  // --------------------------------------------------------------------------

  getConfigOptions(sessionId: string): AcpConfigOption[] | undefined {
    if (!this._sessions.has(sessionId)) return undefined
    const variants = this.variantsForSession(sessionId)
    // A model with no variants gets no picker at all. An empty select would
    // claim a control that has nothing to choose between, which is the same
    // silent lie as claiming the capability outright.
    if (variants.length === 0) return []
    return [
      {
        id: VARIANT_OPTION_ID,
        name: "Model variant",
        description: "Reasoning effort and token budget overlays declared by this model.",
        category: "thought_level",
        type: "select",
        currentValue: this.sessionVariants.get(sessionId) ?? NO_VARIANT,
        options: [
          { value: NO_VARIANT, name: "Base model", description: "No variant overlay." },
          ...variants.map((variant) => ({ value: variant, name: variant })),
        ],
      },
    ]
  }

  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string | boolean
  ): Promise<AcpConfigOption[]> {
    if (!this._sessions.has(sessionId)) throw new Error(`Session not found: ${sessionId}`)
    if (configId !== VARIANT_OPTION_ID) throw new Error(`Unknown config option: ${configId}`)
    if (typeof value !== "string") {
      throw new Error(`Config option ${configId} requires a string value`)
    }
    const variant = value === NO_VARIANT ? undefined : value
    // Refuse a variant this model never published. OpenCode would answer with a
    // model-resolution failure on the next prompt instead of here, which reads
    // as "the agent broke" rather than "that variant does not exist".
    if (variant && !this.variantsForSession(sessionId).includes(variant)) {
      throw new Error(`OpenCode V2 model has no variant "${variant}"`)
    }
    const modelId = this.models.get(sessionId)?.currentModelId
    if (!modelId) throw new Error("OpenCode V2 session has no model to apply a variant to")
    await this.switchModel(sessionId, modelId, variant)
    return this.getConfigOptions(sessionId) ?? []
  }

  /** The variant ids the session's CURRENT model declares. */
  private variantsForSession(sessionId: string): string[] {
    const modelId = this.models.get(sessionId)?.currentModelId
    return (modelId && this.modelVariants.get(modelId)) || []
  }

  /**
   * The one place a model reference is written, so model and variant can never
   * be sent as a mismatched pair.
   */
  private async switchModel(
    sessionId: string,
    modelId: string,
    variant: string | undefined
  ): Promise<void> {
    const [providerID, id] = modelId.split("/", 2)
    if (!providerID || !id) throw new Error("OpenCode V2 model must use provider/model format")
    unwrap(
      await this.requireClient().v2.session.switchModel({
        sessionID: sessionId,
        model: { providerID, id, ...(variant ? { variant } : {}) },
      })
    )
    const current = this.models.get(sessionId)
    if (current) this.models.set(sessionId, { ...current, currentModelId: modelId })
    if (variant) this.sessionVariants.set(sessionId, variant)
    else this.sessionVariants.delete(sessionId)
  }

  getAvailableCommands(): AcpAvailableCommand[] {
    return [...this.commands]
  }

  async getCompactionCapability(sessionId: string): Promise<ExternalAgentCompactionCapability> {
    const command = await this.getAdvertisedCommandCompactionCapability(sessionId)
    if (!this.isConnected()) return { status: "unknown", routes: [], reason: "not_connected" }
    if (this.nativeCompactionUnsupported) return command
    return {
      status: "supported",
      routes: [{ kind: "native", supportsFocus: false }, ...command.routes],
    }
  }

  getProviderUndoCapability(sessionId: string) {
    return this.getAdvertisedProviderUndoCapability(sessionId)
  }

  undoLastProviderChange(sessionId: string) {
    return this.undoWithAdvertisedCommand(sessionId)
  }

  async compactSession(
    sessionId: string,
    options: ExternalAgentCompactionOptions = {}
  ): Promise<void> {
    if (options.focus) {
      await this.compactWithAdvertisedCommand(sessionId, options)
      return
    }
    const client = this.requireClient()
    try {
      unwrap(await client.v2.session.compact({ sessionID: sessionId }))
    } catch (error) {
      if (!isExplicitlyUnsupportedCapabilityError(error)) throw error
      this.nativeCompactionUnsupported = true
      await this.compactWithAdvertisedCommand(sessionId, options)
      return
    }
    unwrap(await client.v2.session.wait({ sessionID: sessionId }))
  }

  private requireClient(): OpencodeClient {
    if (!this.client) throw new Error("Not connected to OpenCode V2 service")
    return this.client
  }

  private async discoverCapabilities(): Promise<void> {
    const client = this.requireClient()
    const commandResult = unwrap<Record<string, unknown>>(await client.v2.command.list())
    const rawCommands = Array.isArray(commandResult.data)
      ? (commandResult.data as Array<Record<string, unknown>>)
      : []
    this.commands = rawCommands.flatMap((command): AcpAvailableCommand[] => {
      const name = readString(command.name)
      const template = readString(command.template) ?? ""
      if (!name) return []
      return [
        {
          name,
          description: readString(command.description) ?? "",
          input: template.includes("$ARGUMENTS") ? { hint: "$ARGUMENTS" } : null,
        },
      ]
    })

    const modelResult = unwrap<Record<string, unknown>>(await client.v2.model.list())
    const rawModels = Array.isArray(modelResult.data)
      ? (modelResult.data as Array<Record<string, unknown>>)
      : []
    const availableModels = rawModels
      .filter((model) => model.enabled !== false)
      .map((model) => ({
        modelId: `${readString(model.providerID) ?? ""}/${readString(model.id) ?? ""}`,
        name: readString(model.name) ?? readString(model.id) ?? "Unknown model",
      }))
      .filter((model) => !model.modelId.startsWith("/") && !model.modelId.endsWith("/"))
    // `ModelV2Info.variants` is the only place the ids are published. A model
    // with none simply gets no entry, and `getConfigOptions` then offers no
    // picker rather than an empty one.
    this.modelVariants.clear()
    for (const model of rawModels) {
      const modelId = `${readString(model.providerID) ?? ""}/${readString(model.id) ?? ""}`
      if (modelId.startsWith("/") || modelId.endsWith("/")) continue
      const variants = Array.isArray(model.variants)
        ? (model.variants as Array<Record<string, unknown>>)
            .map((variant) => readString(variant.id))
            .filter((id): id is string => !!id)
        : []
      if (variants.length > 0) this.modelVariants.set(modelId, variants)
    }
    this.models.set("__default__", {
      availableModels,
      currentModelId: availableModels[0]?.modelId ?? "",
    })
  }

  private attachRuntimeMetadata(session: ExternalAgentSession): void {
    const defaultModels = this.models.get("__default__")
    const model = readString(session.metadata?.model)
    if (defaultModels) {
      this.models.set(session.id, {
        ...defaultModels,
        currentModelId: model ?? defaultModels.currentModelId,
      })
    }
    const variant = readString(session.metadata?.modelVariant)
    if (variant) this.sessionVariants.set(session.id, variant)
    else this.sessionVariants.delete(session.id)
    // `configOptions` on the session is what seeds the panel before any event
    // arrives (`use-external-agent` reads it on activation), so the variant
    // picker is there from the first render instead of after the first change.
    session.metadata = {
      ...session.metadata,
      availableCommands: this.getAvailableCommands(),
      configOptions: this.getConfigOptions(session.id),
    }
  }

  private mapSession(info: SessionV2Info): ExternalAgentSession {
    return {
      id: info.id,
      agentId: this._config?.id ?? "opencode-v2",
      status: "active",
      permissionMode: this._config?.defaultPermissionMode ?? "default",
      createdAt: toDate(info.time?.created),
      lastActivityAt: toDate(info.time?.updated),
      messages: [],
      metadata: {
        title: info.title,
        projectID: info.projectID,
        directory: info.location?.directory,
        parentID: info.parentID,
        model: info.model ? `${info.model.providerID}/${info.model.id}` : undefined,
        // `SessionV2Info.model` is a `ModelRef`, so the variant a session was
        // created or switched onto is readable back rather than inferred — the
        // picker opens on what OpenCode is actually running, including for a
        // session this process did not create.
        modelVariant: info.model?.variant,
        preview: true,
      },
    }
  }

  private mapEvent(sessionId: string, raw: unknown): ExternalAgentEvent[] {
    const event = readRecord(raw)
    const type = readString(event?.type)
    const data = readRecord(event?.properties) ?? readRecord(event?.data)
    const timestamp = eventTime(data)
    const messageId = readString(data?.assistantMessageID) ?? "assistant"

    switch (type) {
      case "session.next.text.started":
        return [{ type: "message_start", sessionId, timestamp, messageId, role: "assistant" }]
      case "session.next.text.delta":
        return [
          {
            type: "message_delta",
            sessionId,
            timestamp,
            messageId,
            delta: { type: "text", text: readString(data?.delta) ?? "" },
          },
        ]
      case "session.next.text.ended":
        return [{ type: "message_end", sessionId, timestamp, messageId }]
      case "session.next.reasoning.delta":
        return [
          {
            type: "thinking",
            sessionId,
            timestamp,
            thinking: readString(data?.delta) ?? "",
          },
        ]
      case "session.next.tool.called":
        return [
          {
            type: "tool_use_start",
            sessionId,
            timestamp,
            toolUseId: readString(data?.callID) ?? "tool",
            toolName: readString(data?.tool) ?? "unknown",
            rawInput: readRecord(data?.input) ?? {},
          },
        ]
      case "session.next.tool.success":
      case "session.next.tool.failed":
        return [
          {
            type: "tool_result",
            sessionId,
            timestamp,
            toolUseId: readString(data?.callID) ?? "tool",
            result: eventResult(
              data?.result ??
                data?.structured ??
                data?.content ??
                readRecord(data?.error)?.message ??
                data?.error
            ),
            isError: type.endsWith("failed"),
          },
        ]
      case "permission.v2.asked":
        return [
          {
            type: "permission_request",
            sessionId,
            timestamp,
            request: {
              id: readString(data?.id) ?? "permission",
              requestId: readString(data?.id) ?? "permission",
              sessionId,
              title: readString(data?.action) ?? "Permission requested",
              toolInfo: {
                id: readString(data?.action) ?? "unknown",
                name: readString(data?.action) ?? "unknown",
              },
              rawInput: { resources: data?.resources },
            },
          },
        ]
      case "session.next.compaction.started":
        return [
          {
            type: "progress",
            sessionId,
            timestamp,
            progress: 0,
            message: "context_compaction",
          },
        ]
      case "session.next.compaction.ended":
        return [
          {
            type: "progress",
            sessionId,
            timestamp,
            progress: 1,
            message: "context_compaction_complete",
          },
        ]
      case "session.next.step.failed":
        return [
          {
            type: "error",
            sessionId,
            timestamp,
            error:
              readString(readRecord(data?.error)?.message) ?? "OpenCode V2 session step failed",
            recoverable: false,
          },
          {
            type: "done",
            sessionId,
            timestamp,
            success: false,
          },
        ]
      case "session.next.step.ended":
        return []
      default:
        return []
    }
  }
}
