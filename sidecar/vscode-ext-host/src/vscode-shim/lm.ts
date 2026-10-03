/**
 * `vscode.lm`: the language model the user configured in Cognia, for
 * extensions to send requests to.
 *
 * `selectChatModels` answers with that one model (vendor `cognia`); an
 * extension never brings its own key or provider. The renderer decides
 * whether a request may go out: the extension needs the `ai:chat`
 * permission, its messages pass the PII gate, and the plugin rate limit
 * applies. A refusal arrives as VS Code's `LanguageModelError`
 * (`NoPermissions`, `Blocked`, `NotFound`).
 *
 * A response streams by pulling: the host asks the renderer for whatever
 * text has arrived (`lm:readChatResponse`) until the renderer says the
 * response is done, so text arrives in order and a slow first token cannot
 * time a request out. `stream` and `text` each replay the response from its
 * start, as in VS Code.
 *
 * Not supported, and said so where an extension meets it:
 *   - Tools: the model never calls an extension's tools. A request whose
 *     `toolMode` is `Required` is refused; with `Auto` the tools are dropped
 *     (the renderer logs it). `lm.tools` is empty and `lm.invokeTool` finds
 *     nothing.
 *   - `registerTool`, `registerChatModelProvider` and
 *     `registerMcpServerDefinitionProvider` are accepted but never used; the
 *     renderer logs each to the extension's log.
 *   - Messages with tool-call, tool-result or prompt-tsx parts are refused:
 *     Cognia's models take text.
 */

import {
  CancellationError,
  LanguageModelChatMessageRole,
  LanguageModelError,
  LanguageModelPromptTsxPart,
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
} from "./api-types"
import { Disposable, EventEmitter, type CancellationToken } from "./types"
import type { RpcConnection } from "../rpc"
import type { ShimDependencies } from "./index"

/** A model as the renderer describes it. */
export interface ChatModelInfo {
  id: string
  name: string
  vendor: string
  family: string
  version: string
  maxInputTokens: number
  /** Whether this extension may send it requests (it holds `ai:chat`). */
  canSendRequest: boolean
}

/** What `lm:sendChatRequest` carries for each message. */
export interface WireChatMessage {
  role: "user" | "assistant" | "system"
  content: string
  name?: string
}

interface WireError {
  code: string
  message: string
}

interface ChatChunk {
  text?: string
  done?: boolean
  error?: WireError
}

/** VS Code's proposed `System` role, which some extensions already send. */
const SYSTEM_ROLE = 3

/**
 * The host's view of the app's models: what the renderer last said about
 * them, for `languageModelAccessInformation`, and the change event.
 */
export class LanguageModels {
  private readonly models = new Map<string, ChatModelInfo>()
  readonly changed = new EventEmitter<void>()

  attach(connection: RpcConnection): void {
    // The app's model changed (the user picked another provider or model).
    connection.onRequest("lm:modelsChanged", (params) => {
      const { models } = params as { models?: unknown }
      this.models.clear()
      this.remember(Array.isArray(models) ? (models as ChatModelInfo[]) : [])
      this.changed.fire(undefined)
      return null
    })
  }

  remember(models: readonly ChatModelInfo[]): void {
    for (const model of models) {
      if (model && typeof model.id === "string") this.models.set(model.id, model)
    }
  }

  /** `true` or `false` for a model the renderer has described, else `undefined`. */
  canSendRequest(chat: { id?: unknown } | undefined): boolean | undefined {
    const id = chat?.id
    return typeof id === "string" ? this.models.get(id)?.canSendRequest : undefined
  }
}

function partKind(part: unknown): string {
  if (part instanceof LanguageModelToolCallPart) return "LanguageModelToolCallPart"
  if (part instanceof LanguageModelToolResultPart) return "LanguageModelToolResultPart"
  if (part instanceof LanguageModelPromptTsxPart) return "LanguageModelPromptTsxPart"
  if (part && typeof part === "object") {
    const value = part as Record<string, unknown>
    if ("callId" in value && "name" in value) return "LanguageModelToolCallPart"
    if ("callId" in value) return "LanguageModelToolResultPart"
  }
  return "this message part"
}

/** A part's text, or `null` when it is not a text part. */
function partText(part: unknown): string | null {
  if (typeof part === "string") return part
  if (part instanceof LanguageModelTextPart) return part.value
  if (
    part &&
    typeof part === "object" &&
    !(part instanceof LanguageModelPromptTsxPart) &&
    !("callId" in part) &&
    typeof (part as { value?: unknown }).value === "string"
  ) {
    return (part as { value: string }).value
  }
  return null
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) throw new Error("A language model message needs content")
  return content
    .map((part) => {
      const text = partText(part)
      if (text === null) {
        throw new Error(
          `${partKind(part)} is not supported: Cognia's language models take text messages only`
        )
      }
      return text
    })
    .join("")
}

/** One `LanguageModelChatMessage` as it goes to the renderer. */
export function toWireMessage(message: unknown): WireChatMessage {
  if (!message || typeof message !== "object") {
    throw new Error("A language model message must be a LanguageModelChatMessage")
  }
  const { role, content, name } = message as { role?: unknown; content?: unknown; name?: unknown }
  const wireRole =
    role === LanguageModelChatMessageRole.User
      ? "user"
      : role === LanguageModelChatMessageRole.Assistant
        ? "assistant"
        : role === SYSTEM_ROLE
          ? "system"
          : null
  if (!wireRole) throw new Error(`Unknown language model message role: ${String(role)}`)
  return {
    role: wireRole,
    content: messageText(content),
    ...(typeof name === "string" && name ? { name } : {}),
  }
}

/** `modelOptions` as JSON, dropping what cannot cross the wire. */
function plainOptions(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function wireOptions(options: Record<string, unknown> | undefined): Record<string, unknown> {
  const tools = Array.isArray(options?.tools) ? options.tools : []
  const modelOptions = plainOptions(options?.modelOptions)
  return {
    ...(typeof options?.justification === "string" ? { justification: options.justification } : {}),
    ...(modelOptions ? { modelOptions } : {}),
    toolCount: tools.length,
    ...(typeof options?.toolMode === "number" ? { toolMode: options.toolMode } : {}),
  }
}

/** A refusal or failure the renderer reported, as the error VS Code throws. */
export function toLanguageModelError(error: WireError): Error {
  switch (error.code) {
    case "NoPermissions":
      return LanguageModelError.NoPermissions(error.message)
    case "Blocked":
      return LanguageModelError.Blocked(error.message)
    case "NotFound":
      return LanguageModelError.NotFound(error.message)
    case "Cancelled":
      return new CancellationError()
    default:
      return new LanguageModelError(error.message, error.code || "Unknown")
  }
}

function rpcFailure(error: unknown): Error {
  if (error instanceof Error) return error
  const message = (error as { message?: unknown } | null)?.message
  return new Error(typeof message === "string" ? message : String(error))
}

/**
 * The text of one response as it arrives. Every iteration of `stream` or
 * `text` starts from the first part and ends (or throws) with the response.
 */
export class ChatResponseBuffer {
  private readonly parts: string[] = []
  private ended = false
  private failure: Error | undefined
  private waiters: Array<() => void> = []

  push(text: string): void {
    if (this.ended || !text) return
    this.parts.push(text)
    this.wake()
  }

  end(error?: Error): void {
    if (this.ended) return
    this.ended = true
    this.failure = error
    this.wake()
  }

  private wake(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const wake of waiters) wake()
  }

  async *texts(): AsyncGenerator<string> {
    let index = 0
    for (;;) {
      while (index < this.parts.length) yield this.parts[index++]!
      if (this.ended) {
        if (this.failure) throw this.failure
        return
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
  }

  get response(): { stream: AsyncIterable<LanguageModelTextPart>; text: AsyncIterable<string> } {
    const texts = () => this.texts()
    return {
      stream: {
        [Symbol.asyncIterator]: async function* () {
          for await (const text of texts()) yield new LanguageModelTextPart(text)
        },
      },
      text: { [Symbol.asyncIterator]: texts },
    }
  }
}

let requestSequence = 0

function createChatModel(info: ChatModelInfo, deps: ShimDependencies) {
  const { connection, extensionId } = deps
  return {
    id: info.id,
    name: info.name,
    vendor: info.vendor,
    family: info.family,
    version: info.version,
    maxInputTokens: info.maxInputTokens,

    async sendRequest(
      messages: readonly unknown[],
      options?: Record<string, unknown>,
      token?: CancellationToken
    ) {
      if (token?.isCancellationRequested) throw new CancellationError()
      if (!Array.isArray(messages) || messages.length === 0) {
        throw new Error("A language model request needs at least one message")
      }
      const wire = messages.map(toWireMessage)
      const requestId = `${extensionId}#${++requestSequence}`
      const started = await connection
        .sendRequest<{ error?: WireError } | null>("lm:sendChatRequest", {
          extensionId,
          requestId,
          modelId: info.id,
          messages: wire,
          options: wireOptions(options),
        })
        .catch((error: unknown) => {
          throw rpcFailure(error)
        })
      if (started?.error) throw toLanguageModelError(started.error)

      const buffer = new ChatResponseBuffer()
      const cancellation = token?.onCancellationRequested(() => {
        buffer.end(new CancellationError())
        void connection
          .sendRequest("lm:cancelChatRequest", { extensionId, requestId })
          .catch(() => undefined)
      })
      void (async () => {
        try {
          for (;;) {
            const chunk = await connection.sendRequest<ChatChunk | null>("lm:readChatResponse", {
              extensionId,
              requestId,
            })
            if (chunk?.text) buffer.push(chunk.text)
            if (!chunk || chunk.done) {
              buffer.end(chunk?.error ? toLanguageModelError(chunk.error) : undefined)
              return
            }
          }
        } catch (error) {
          buffer.end(rpcFailure(error))
        } finally {
          cancellation?.dispose()
        }
      })()
      return buffer.response
    },

    async countTokens(value: unknown, token?: CancellationToken): Promise<number> {
      if (token?.isCancellationRequested) throw new CancellationError()
      const text = typeof value === "string" ? value : toWireMessage(value).content
      return connection.sendRequest<number>("lm:countTokens", {
        extensionId,
        modelId: info.id,
        text,
      })
    },
  }
}

export function createLmNamespace(deps: ShimDependencies) {
  const { connection, extensionId, languageModels } = deps
  // Registrations nothing calls back: the renderer logs each to the
  // extension's log, and disposing one is a no-op there.
  const inert = (method: string, payload: Record<string, unknown>) => {
    void connection.sendRequest(method, { extensionId, ...payload }).catch(() => undefined)
    return new Disposable(() => {})
  }
  return {
    async selectChatModels(selector?: {
      vendor?: string
      family?: string
      version?: string
      id?: string
    }) {
      const models = await connection.sendRequest<ChatModelInfo[]>("lm:selectChatModels", {
        extensionId,
        selector: plainOptions(selector) ?? {},
      })
      const list = Array.isArray(models) ? models : []
      languageModels.remember(list)
      return list.map((info) => createChatModel(info, deps))
    },
    onDidChangeChatModels: languageModels.changed.event,

    tools: Object.freeze([]) as readonly unknown[],
    async invokeTool(name: string): Promise<never> {
      throw new Error(`Tool "${name}" was not found: no language model tools are available`)
    },
    registerTool(name: string, _tool: unknown) {
      return inert("lm:registerTool", { name })
    },
    registerChatModelProvider(id: string, _provider: unknown) {
      return inert("lm:registerChatModelProvider", { id })
    },
    registerMcpServerDefinitionProvider(id: string, _provider: unknown) {
      return inert("lm:registerMcpServerDefinitionProvider", { id })
    },
  }
}
