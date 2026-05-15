/**
 * `vscode.lm` handler — bridges VS Code's Language Model API to cognia's
 * AI provider abstraction.
 *
 * Wired by `rpc-dispatcher.ts`. Responsibilities:
 *
 *   - `lm:selectChatModels` returns cognia's configured Claude model list.
 *     Selector filters (`vendor`, `family`, `version`, `id`) are honoured
 *     so extensions that only support a specific vendor get a coherent
 *     subset rather than `undefined`.
 *   - `lm:sendChatRequest` issues a non-streaming Anthropic call via the
 *     existing `lib/ai/core/client.ts:getProviderModel` adapter
 *     (same path cognia uses for vision captioning). Streaming support is
 *     deferred to the next iteration per the velvet-diffie plan.
 *   - `lm:registerChatModelProvider` / `lm:registerMcpServerDefinitionProvider` /
 *     `lm:registerTool` record the registration locally. The actual
 *     surfacing of these provider-backed definitions into cognia's MCP
 *     gallery / native-tool registry happens at query time so the
 *     extension's `provide*` callbacks can be invoked through the sidecar
 *     RPC. The provider tokens are stored here for that round-trip.
 *   - `lm:unregisterChatModelProvider` / `lm:unregisterMcpServerDefinitionProvider` /
 *     `lm:unregisterTool` (notifications) drop the matching entries.
 *
 * All five canonical models live in {@link BASE_MODELS}. The
 * currently-active default is read via the injected resolver
 * ({@link configureLmHandler}); the loader wires this to
 * `lib/claude/settings.ts` at app bootstrap.
 */

import { generateText, type ModelMessage } from "ai"
import { getProviderModel } from "@/lib/ai/core/client"
import { loggers } from "@/lib/logger"

const lmHandlerLogger = loggers.plugin.child("vscode-lm")

export interface CogniaChatModel {
  /** Anthropic model id, e.g. `claude-opus-4-7`. */
  id: string
  /** Display name shown in extension UI. */
  name: string
  /** VS Code convention: vendor namespace. */
  vendor: string
  /** VS Code convention: model family. */
  family: string
  /** Approximate context window, in tokens. */
  maxInputTokens: number
  /** Approximate output token budget. */
  maxOutputTokens: number
  version: string
  /** True if this is the model cognia is currently configured to use. */
  isDefault: boolean
}

/**
 * The three canonical Claude models cognia supports. The set mirrors the
 * project-level constants under `~/.claude/CLAUDE.md`. Update both lists
 * if Anthropic rotates IDs.
 */
const BASE_MODELS: Omit<CogniaChatModel, "isDefault">[] = [
  {
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    vendor: "cognia",
    family: "anthropic",
    maxInputTokens: 1_000_000,
    maxOutputTokens: 32_000,
    version: "4.7",
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    vendor: "cognia",
    family: "anthropic",
    maxInputTokens: 200_000,
    maxOutputTokens: 16_000,
    version: "4.6",
  },
  {
    id: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5",
    vendor: "cognia",
    family: "anthropic",
    maxInputTokens: 200_000,
    maxOutputTokens: 8_192,
    version: "4.5",
  },
]

interface LmSelector {
  vendor?: string
  family?: string
  version?: string
  id?: string
}

interface LmSelectorPayload {
  extensionId: string
  selector?: LmSelector
}

interface LmSendRequestPayload {
  extensionId: string
  modelId?: string
  messages: Array<{
    role: "user" | "assistant" | "system"
    content: string
  }>
  options?: {
    apiKey?: string
    temperature?: number
    maxOutputTokens?: number
  }
}

interface ProviderRegistration {
  extensionId: string
  id: string
  token: string
  kind: "chatModel" | "mcpServer" | "tool"
  meta?: Record<string, unknown>
}

const providerRegistry = new Map<string, ProviderRegistration>()

let resolveDefaultModelImpl: (() => Promise<string | undefined>) | null = null

/**
 * Lets the loader inject the way the handler discovers cognia's currently
 * configured default model. Decoupled so this module stays jest-friendly
 * and the unit tests don't pull in Tauri.
 */
export function configureLmHandler(opts: {
  resolveDefaultModel: () => Promise<string | undefined>
}): void {
  resolveDefaultModelImpl = opts.resolveDefaultModel
}

/** Test-only escape hatch. */
export function __resetLmHandlerForTesting(): void {
  resolveDefaultModelImpl = null
  providerRegistry.clear()
}

async function resolveDefaultModelId(): Promise<string> {
  if (resolveDefaultModelImpl) {
    try {
      const configured = await resolveDefaultModelImpl()
      if (configured && BASE_MODELS.some((m) => m.id === configured)) {
        return configured
      }
    } catch (err) {
      lmHandlerLogger.warn("resolveDefaultModel threw; falling back to sonnet", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return "claude-sonnet-4-6"
}

export async function handleSelectChatModels(
  payload: LmSelectorPayload
): Promise<CogniaChatModel[]> {
  const defaultId = await resolveDefaultModelId()
  const all: CogniaChatModel[] = BASE_MODELS.map((m) => ({
    ...m,
    isDefault: m.id === defaultId,
  }))
  const selector = payload.selector ?? {}
  return all.filter((m) => {
    if (selector.vendor && m.vendor !== selector.vendor) return false
    if (selector.family && m.family !== selector.family) return false
    if (selector.version && m.version !== selector.version) return false
    if (selector.id && m.id !== selector.id) return false
    return true
  })
}

export async function handleSendChatRequest(payload: LmSendRequestPayload): Promise<{
  modelId: string
  text: string
  usage?: { inputTokens?: number; outputTokens?: number }
}> {
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    throw new Error("lm:sendChatRequest requires at least one message")
  }
  const modelId = payload.modelId ?? (await resolveDefaultModelId())
  if (!BASE_MODELS.some((m) => m.id === modelId)) {
    throw new Error(`lm:sendChatRequest unknown model: ${modelId}`)
  }
  const model = getProviderModel({
    provider: "anthropic",
    model: modelId,
    apiKey: payload.options?.apiKey,
  })
  const messages: ModelMessage[] = payload.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }))
  const result = await generateText({
    model,
    messages,
    temperature: payload.options?.temperature,
  })
  return {
    modelId,
    text: result.text,
    usage: result.usage
      ? {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
        }
      : undefined,
  }
}

interface LmRegisterChatModelProviderPayload {
  extensionId: string
  id: string
  token: string
}

interface LmRegisterMcpPayload {
  extensionId: string
  id: string
  token: string
  meta?: Record<string, unknown>
}

interface LmRegisterToolPayload {
  extensionId: string
  name: string
  token: string
  description?: string
  inputSchema?: Record<string, unknown>
}

interface LmUnregisterByIdPayload {
  extensionId: string
  id?: string
  name?: string
}

export function handleRegisterChatModelProvider(payload: LmRegisterChatModelProviderPayload): {
  registered: true
} {
  providerRegistry.set(payload.token, {
    extensionId: payload.extensionId,
    id: payload.id,
    token: payload.token,
    kind: "chatModel",
  })
  return { registered: true }
}

export function handleUnregisterChatModelProvider(payload: LmUnregisterByIdPayload): void {
  if (!payload.id) return
  for (const [token, entry] of providerRegistry) {
    if (
      entry.kind === "chatModel" &&
      entry.extensionId === payload.extensionId &&
      entry.id === payload.id
    ) {
      providerRegistry.delete(token)
    }
  }
}

export function handleRegisterMcpServerDefinitionProvider(payload: LmRegisterMcpPayload): {
  registered: true
} {
  providerRegistry.set(payload.token, {
    extensionId: payload.extensionId,
    id: payload.id,
    token: payload.token,
    kind: "mcpServer",
    meta: payload.meta,
  })
  return { registered: true }
}

export function handleUnregisterMcpServerDefinitionProvider(
  payload: LmUnregisterByIdPayload
): void {
  if (!payload.id) return
  for (const [token, entry] of providerRegistry) {
    if (
      entry.kind === "mcpServer" &&
      entry.extensionId === payload.extensionId &&
      entry.id === payload.id
    ) {
      providerRegistry.delete(token)
    }
  }
}

export function handleRegisterTool(payload: LmRegisterToolPayload): { registered: true } {
  providerRegistry.set(payload.token, {
    extensionId: payload.extensionId,
    id: payload.name,
    token: payload.token,
    kind: "tool",
    meta: {
      description: payload.description,
      inputSchema: payload.inputSchema,
    },
  })
  return { registered: true }
}

export function handleUnregisterTool(payload: LmUnregisterByIdPayload): void {
  if (!payload.name) return
  for (const [token, entry] of providerRegistry) {
    if (
      entry.kind === "tool" &&
      entry.extensionId === payload.extensionId &&
      entry.id === payload.name
    ) {
      providerRegistry.delete(token)
    }
  }
}

/** Drop every lm-registered provider owned by `extensionId`. */
export function unregisterAllLmFor(extensionId: string): void {
  for (const [token, entry] of providerRegistry) {
    if (entry.extensionId === extensionId) {
      providerRegistry.delete(token)
    }
  }
}

/** Snapshot for testing and inspection. */
export function __listLmRegistrationsForTesting(): ProviderRegistration[] {
  return [...providerRegistry.values()]
}
