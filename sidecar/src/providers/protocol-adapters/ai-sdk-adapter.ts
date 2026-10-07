// Built-in protocol adapter: wraps the historical `@ai-sdk/*` execution path
// behind the ProtocolAdapter seam. Behavior is intentionally byte-identical
// to the pre-seam `ai-sdk.mjs` inline code — `ai-sdk.test.mjs` is the canary
// and must pass without edits.

// Endpoint-family knowledge (provider→protocol map + Responses-vs-Chat decision)
// lives in the single-source-of-truth `provider-protocol.ts`. Re-export the two
// host helpers so existing importers (and the canary test) keep their public
// surface; `decideOpenAiEndpointFlavor` is the one decision both the sidecar and
// the renderer now share.
import {
  anthropicSdkBaseURL,
  isGenuineOpenAiEndpoint,
  isResponsesOnlyEndpoint,
  isOpenAiNativeSurface,
  decideOpenAiEndpointFlavor,
  RESPONSES_ONLY_PROVIDERS,
  resolveProviderProtocol,
} from "../provider-protocol.ts"
import { buildBedrockProviderOptions } from "../bedrock.ts"
import { partitionPrompt } from "../prompt-partition.ts"
import { aiSdkTelemetry, withTraceparent } from "../../platform/telemetry/index.ts"
import { EFFORT_TO_BUDGET, OPENAI_EFFORT_VALUES } from "../reasoning-effort-tables.ts"
import type { LanguageModelMiddleware, ProviderMetadata } from "ai"
import type {
  AdapterResult,
  NormalizedRequest,
  ProtocolAdapter,
  ReasoningControls,
} from "./types.ts"

/** A model `wrapLanguageModel` accepts: what every provider factory returns. */
type ProviderModel = Parameters<(typeof import("ai"))["wrapLanguageModel"]>[0]["model"]

/** Per-provider `providerOptions`: provider key → its option block. */
export type ProviderOptionsMap = Record<string, Record<string, unknown>>

/** Everything `buildModel` needs to construct one provider model. */
export interface ModelSettings {
  protocol: string | null
  model: string
  apiKey?: string | undefined
  baseURL?: string | undefined
  headers?: Record<string, string> | undefined
  apiFlavor?: string | undefined
  providerId?: string | undefined
  bedrockAuthMode?: string | undefined
  region?: string | undefined
  accessKeyId?: string | undefined
  secretAccessKey?: string | undefined
  sessionToken?: string | undefined
  profile?: string | undefined
  roleArn?: string | undefined
  roleSessionName?: string | undefined
}

export { isGenuineOpenAiEndpoint, isResponsesOnlyEndpoint }

// The budget tiers (anthropic/google) and the OpenAI-accepted effort values now
// live in the dependency-free `reasoning-effort-tables.ts`, so the renderer can
// read the SAME constants to decide which tiers to OFFER without importing this
// module (which drags in the whole AI SDK). Re-exported for existing importers.
export { EFFORT_TO_BUDGET, OPENAI_EFFORT_VALUES }

/**
 * Map an effort "thinking level" to a token budget for the budget-driven
 * providers (anthropic / google). An unrecognized level falls back to the
 * `high` tier rather than `undefined`, so a reasoning level never silently
 * leaves thinking OFF. Returns null only when no effort is given.
 */
function effortToBudget(effort: string | null): number | null {
  if (!effort) return null
  return (EFFORT_TO_BUDGET as Readonly<Record<string, number>>)[effort] ?? EFFORT_TO_BUDGET.high
}

/**
 * Normalize the app's effort level to a value OpenAI's `reasoningEffort`
 * accepts: fold "max" down to the nearest valid ceiling "xhigh", and clamp
 * anything unexpected to "high" so an out-of-range level never 400s the call.
 */
function normalizeOpenAiEffort(effort: string): string {
  if (effort === "max") return "xhigh"
  return OPENAI_EFFORT_VALUES.has(effort) ? effort : "high"
}

/**
 * Translate the app's reasoning controls (`effort` "thinking level" and/or
 * `maxThinkingTokens` budget) into the AI SDK's per-provider `providerOptions`
 * block that ENABLES reasoning. Without this the AI-SDK path never turns
 * reasoning on — `maxThinkingTokens`/`effort` were built by resolveSendOptions
 * but dropped here, so a non-Anthropic reasoning model ran with thinking off
 * (the Anthropic path defaults it on). Returns `null` when nothing applies.
 * `baseURL` and `opts.providerId` gate the openai branch (see below).
 */
export function buildReasoningProviderOptions(
  protocol: string | null,
  baseURL: string | undefined,
  reasoning: ReasoningControls | null | undefined,
  opts: { providerId?: string | undefined } = {}
): ProviderOptionsMap | null {
  if (!reasoning) return null
  const effort = typeof reasoning.effort === "string" && reasoning.effort ? reasoning.effort : null
  const budget =
    typeof reasoning.maxThinkingTokens === "number" && reasoning.maxThinkingTokens > 0
      ? reasoning.maxThinkingTokens
      : null
  if (!effort && !budget) return null

  switch (protocol) {
    case "anthropic": {
      const budgetTokens = budget ?? effortToBudget(effort)
      if (!budgetTokens) return null
      return { anthropic: { thinking: { type: "enabled", budgetTokens } } }
    }
    case "google": {
      const thinkingBudget = budget ?? effortToBudget(effort)
      if (!thinkingBudget) return null
      return { google: { thinkingConfig: { thinkingBudget, includeThoughts: true } } }
    }
    case "openai": {
      // `reasoning_effort` is an OpenAI Responses/Chat field. Emit it ONLY for an
      // OpenAI-native surface — OpenAI-compatible gateways (DeepSeek, Groq,
      // Ollama, …) implement their own reasoning and may 400 on an unknown
      // field; their models surface reasoning unprompted regardless. The check
      // is `isOpenAiNativeSurface`, not a bare host test: Codex's ChatGPT
      // backend (chatgpt.com) and its relay presets are native surfaces whose
      // hosts are NOT *.openai.com, so a host-only gate silently dropped these
      // options for the entire Codex subscription path — reasoning ran off and
      // invisible on the one provider whose models are all reasoning models.
      if (!effort || !isOpenAiNativeSurface({ providerId: opts.providerId, baseURL })) return null
      // `reasoningSummary: "auto"` is REQUIRED for the reasoning to be visible:
      // OpenAI o-series / gpt-5 emit NO reasoning parts in the stream without it,
      // so the user would pay for reasoning tokens and see nothing.
      return {
        openai: { reasoningEffort: normalizeOpenAiEffort(effort), reasoningSummary: "auto" },
      }
    }
    default:
      // mistral / cohere have no standard reasoning-enable option in the SDK.
      return null
  }
}

/**
 * The Responses-API request fields Codex itself sends, which the AI SDK does not
 * default for us. Verified against `openai/codex`
 * (`codex-rs/core/src/client.rs:build_responses_request`):
 *
 *   • `store: false` — Codex sets `store` to `is_azure_responses_endpoint()`,
 *     i.e. false for BOTH the ChatGPT backend and api.openai.com. Omitting it
 *     lets the server default (`store: true`) stand, so every Codex turn is
 *     persisted server-side against the user's account — the opposite of what
 *     the Codex client does, and wrong for a zero-retention subscription.
 *   • `include: ["reasoning.encrypted_content"]` — sent when reasoning is on.
 *     With `store: false` the server keeps no reasoning state, so without this
 *     the encrypted reasoning item never comes back and the model loses its
 *     chain of thought between turns of an agentic loop.
 *
 * Scoped to the responses-only provider ids (codex) and the responses flavor:
 * the general-purpose `openai` provider keeps the server's storage default,
 * which existing users may rely on.
 */
export function buildCodexResponsesProviderOptions({
  providerId,
  flavor,
  hasReasoning,
}: {
  providerId?: string | undefined
  flavor: string
  hasReasoning: boolean
}): ProviderOptionsMap | null {
  if (!providerId || !RESPONSES_ONLY_PROVIDERS.has(providerId)) return null
  if (flavor !== "responses") return null
  return {
    openai: {
      store: false,
      ...(hasReasoning ? { include: ["reasoning.encrypted_content"] } : {}),
    },
  }
}

/** Deep-merge two `providerOptions` maps one level into each provider key. */
function mergeProviderOptions(
  base: ProviderOptionsMap | null | undefined,
  extra: ProviderOptionsMap | null | undefined
): ProviderOptionsMap | undefined {
  if (!extra) return base ?? undefined
  const out: ProviderOptionsMap = { ...(base ?? {}) }
  for (const [provider, opts] of Object.entries(extra)) {
    out[provider] = { ...(out[provider] ?? {}), ...opts }
  }
  return out
}

/**
 * Wrap a model so inline `<think>…</think>` reasoning is extracted into proper
 * reasoning parts instead of leaking into the visible answer text. Many models
 * served over the OpenAI-compatible / chat protocols (DeepSeek-R1 distills,
 * QwQ-style and other reasoning checkpoints without a dedicated reasoning
 * channel) emit their chain-of-thought as a literal `<think>` block in the
 * content. `extractReasoningMiddleware` pulls it out so it renders as a
 * collapsible reasoning block, not as garbage in the answer. Harmless
 * pass-through for models that already stream reasoning natively or never emit
 * the tag — nothing is extracted, the text flows unchanged.
 */
export function rawAnalysisProvenanceMiddleware(): LanguageModelMiddleware {
  const mark = <P extends { providerMetadata?: ProviderMetadata | undefined }>(part: P): P => ({
    ...part,
    providerMetadata: {
      ...(part.providerMetadata ?? {}),
      cognia: {
        ...(part.providerMetadata?.cognia ?? {}),
        reasoningSource: "raw-analysis",
      },
    },
  })

  return {
    specificationVersion: "v3",
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate()
      return {
        ...result,
        content: result.content.map((part) => (part.type === "reasoning" ? mark(part) : part)),
      }
    },
    wrapStream: async ({ doStream }) => {
      const result = await doStream()
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream({
            transform(chunk, controller) {
              controller.enqueue(
                chunk.type === "reasoning-start" ||
                  chunk.type === "reasoning-delta" ||
                  chunk.type === "reasoning-end"
                  ? mark(chunk)
                  : chunk
              )
            },
          })
        ),
      }
    },
  }
}

export async function withReasoningExtraction(
  model: ProviderModel,
  modelId: string | undefined = model.modelId
): Promise<ProviderModel> {
  const { wrapLanguageModel, extractReasoningMiddleware } = await import("ai")
  const extracted = wrapLanguageModel({
    model,
    middleware: extractReasoningMiddleware({ tagName: "think" }),
  })
  if (!/gpt-oss/i.test(modelId ?? "")) return extracted
  return wrapLanguageModel({
    model: extracted,
    middleware: rawAnalysisProvenanceMiddleware(),
  })
}

/**
 * Build a model instance for one of the five built-in AI SDK protocols.
 * Lazy-imports the per-provider SDKs so the sidecar's cold start doesn't pay
 * for OpenAI when the user is on Anthropic, etc. Every model is wrapped with
 * `<think>`-tag reasoning extraction (see withReasoningExtraction).
 */
export async function buildModel({
  protocol,
  model,
  apiKey,
  baseURL,
  headers,
  apiFlavor,
  providerId,
  bedrockAuthMode,
  region,
  accessKeyId,
  secretAccessKey,
  sessionToken,
  profile,
  roleArn,
  roleSessionName,
}: ModelSettings): Promise<ProviderModel> {
  const base = await buildRawModel({
    protocol: providerId === "commandcode" ? resolveProviderProtocol(providerId, model) : protocol,
    model,
    apiKey,
    baseURL,
    headers,
    apiFlavor,
    providerId,
    bedrockAuthMode,
    region,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    profile,
    roleArn,
    roleSessionName,
  })
  return withReasoningExtraction(base, model)
}

/** Construct the un-wrapped provider model. Split out so the wrap is uniform. */
async function buildRawModel({
  protocol,
  model,
  apiKey,
  baseURL,
  headers,
  apiFlavor,
  providerId,
  bedrockAuthMode,
  region,
  accessKeyId,
  secretAccessKey,
  sessionToken,
  profile,
  roleArn,
  roleSessionName,
}: ModelSettings): Promise<ProviderModel> {
  switch (protocol) {
    case "openai": {
      // The resolver intentionally keeps DeepSeek in the openai wire-protocol
      // family, but the official adapter understands DeepSeek's native
      // reasoning_content stream and prompt-cache usage fields. Preserve an
      // explicit Responses override for compatible relays: the DeepSeek
      // provider itself only exposes Chat Completions.
      if (providerId === "deepseek" && apiFlavor !== "responses") {
        const { createDeepSeek } = await import("@ai-sdk/deepseek")
        return createDeepSeek({ apiKey, baseURL, headers }).chat(model)
      }
      const { createOpenAI } = await import("@ai-sdk/openai")
      // `headers` carries the Codex ChatGPT-login extras (ChatGPT-Account-Id,
      // OpenAI-Beta, originator, OAI-Product-Sku); undefined for everyone else.
      const client = createOpenAI({ apiKey, baseURL, headers })
      // Pick the endpoint family explicitly. As of @ai-sdk/openai v3 the bare
      // `client(model)` returns a Responses-API model that POSTs to `/responses`
      // — an OpenAI-proprietary endpoint. The OpenAI-*compatible* gateways this
      // protocol also serves (DeepSeek, OpenCode, Groq, Ollama, …) only implement
      // `/chat/completions`, so routing them to `/responses` 404s. The shared
      // decision honors an explicit `apiFlavor` (so the user can opt a gateway /
      // custom URL into Responses) and otherwise falls back to the host/id
      // heuristic. `providerId` is REQUIRED for that heuristic's id arm
      // (RESPONSES_ONLY_PROVIDERS): dropping it here made codex-on-a-relay-preset
      // fall through to `.chat()` while the renderer — which does pass it — said
      // `.responses()`, the exact drift this shared module exists to prevent.
      const flavor = decideOpenAiEndpointFlavor({ apiFlavor, baseURL, providerId })
      return flavor === "responses" ? client.responses(model) : client.chat(model)
    }
    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic")
      // `headers` = the provider's static customHeaders (settings UI); undefined
      // for most rows. Same treatment as the openai/azure branches.
      // Settings carry Claude Code's `ANTHROPIC_BASE_URL` root; the SDK client
      // wants the versioned base (see `anthropicSdkBaseURL`).
      const client = createAnthropic({ apiKey, baseURL: anthropicSdkBaseURL(baseURL), headers })
      return client(model)
    }
    case "google": {
      const { createGoogle } = await import("@ai-sdk/google")
      // `headers` = the provider's static customHeaders (settings UI); undefined
      // for most rows. Same treatment as the openai/azure branches.
      const client = createGoogle({ apiKey, baseURL, headers })
      return client(model)
    }
    case "mistral": {
      const { createMistral } = await import("@ai-sdk/mistral")
      // `headers` = the provider's static customHeaders (settings UI); undefined
      // for most rows. Same treatment as the openai/azure branches.
      const client = createMistral({ apiKey, baseURL, headers })
      return client(model)
    }
    case "cohere": {
      const { createCohere } = await import("@ai-sdk/cohere")
      // `headers` = the provider's static customHeaders (settings UI); undefined
      // for most rows. Same treatment as the openai/azure branches.
      const client = createCohere({ apiKey, baseURL, headers })
      return client(model)
    }
    case "azure": {
      const { createAzure } = await import("@ai-sdk/azure")
      // Azure Foundry serves the OpenAI surface behind a per-resource endpoint.
      // The resolver carries that full endpoint as `baseURL`; `headers` is
      // forwarded for parity with the openai path (usually undefined).
      const client = createAzure({ apiKey, baseURL, headers })
      // Azure exposes BOTH /chat/completions and the newer /responses. Default
      // to chat (conservative for existing deployments); `apiFlavor: "responses"`
      // opts a resource into the Responses API. Same shared decision as openai.
      const flavor = decideOpenAiEndpointFlavor({ apiFlavor, baseURL, providerId: "azure" })
      return flavor === "responses" ? client.responses(model) : client.chat(model)
    }
    case "bedrock": {
      const { createAmazonBedrock } = await import("@ai-sdk/amazon-bedrock")
      const options = await buildBedrockProviderOptions({
        authMode: bedrockAuthMode ?? (apiKey ? "api-key" : "default-chain"),
        region,
        apiKey,
        baseURL,
        accessKeyId,
        secretAccessKey,
        sessionToken,
        profile,
        roleArn,
        roleSessionName,
      })
      const client = createAmazonBedrock(options)
      return client(model)
    }
    default:
      throw new Error(`unsupported AI SDK protocol: ${protocol}`)
  }
}

/** The `streamText` result members this adapter reads (lazy promise getters). */
interface StreamTextResultLike {
  stream?: AsyncIterable<unknown>
  /** The pre-v7 name of `stream`, still a deprecated alias. */
  fullStream?: AsyncIterable<unknown>
  responseMessages?: unknown
  response?: PromiseLike<{ messages?: unknown[] }>
  usage?: PromiseLike<unknown>
  steps?: unknown
}

/** The adapter for one of the built-in AI SDK protocols. */
export function makeAiSdkAdapter(protocol: string): ProtocolAdapter {
  return {
    id: `ai-sdk:${protocol}`,
    async start(req: NormalizedRequest): Promise<AdapterResult> {
      const creds = req.credentials ?? {}
      const providerId = req.providerId
      const modelProtocol =
        providerId === "commandcode" ? resolveProviderProtocol(providerId, req.model) : protocol
      const modelInstance = await buildModel({
        protocol: modelProtocol,
        model: req.model,
        apiKey: creds.apiKey,
        baseURL: creds.baseURL,
        headers: creds.headers,
        apiFlavor: creds.apiFlavor,
        providerId,
        bedrockAuthMode: creds.bedrockAuthMode,
        region: creds.region,
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
        profile: creds.profile,
        roleArn: creds.roleArn,
        roleSessionName: creds.roleSessionName,
      })
      // `streamArgs` is assembled from renderer-provided `modelParams`, so it is
      // a plain record here and the SDK validates it.
      const streamTextFn: (args: Record<string, unknown>) => unknown =
        req.streamTextFn ??
        ((await import("ai")).streamText as unknown as (args: Record<string, unknown>) => unknown)
      // System content must travel in the top-level instructions option — AI SDK
      // 7 rejects `{ role: "system" }` inside `messages` by default. Splitting
      // here (rather than in `dispatch/ai-sdk.mjs`, which builds the flat
      // conversation) keeps compaction and tool-pairing operating on the combined
      // array. Anthropic cacheControl breakpoints ride along per-message.
      const streamArgs: Record<string, unknown> = {
        model: modelInstance,
        ...partitionPrompt(req.messages),
        ...(req.modelParams ?? {}),
      }
      // OpenCode Go requires an honest client identity and stable per-conversation
      // session header, including auxiliary requests (docs checked 2026-09-11).
      // Use the provider id so the contract survives a configured gateway relay.
      if (providerId === "opencode" || providerId === "opencode-go") {
        streamArgs.headers = {
          ...((streamArgs.headers as Record<string, string> | undefined) ?? {}),
          "User-Agent": "cognia-coding-agent/1.0",
          ...(req.sessionId ? { "x-opencode-session": req.sessionId } : {}),
        }
      }
      const telemetryOptions = aiSdkTelemetry({
        sessionId: req.sessionId,
        traceId: req.traceId,
        surface: req.surface,
        runId: req.runId,
        turnId: req.turnId,
        attemptId: req.attemptId,
        projectId: req.projectId,
        feature: req.feature,
        promptComponentIds: req.promptComponentIds,
        promptVersion: req.promptVersion,
        promptFingerprint: req.promptFingerprint,
        provider: providerId ?? protocol,
        traceparent: req.traceparent,
      })
      if (telemetryOptions) {
        // `experimental_telemetry` graduated to `telemetry` in AI SDK 7.
        const {
          traceparent: _traceparent,
          runtimeContext: telemetryRuntimeContext,
          ...publicTelemetry
        } = telemetryOptions
        streamArgs.telemetry = publicTelemetry
        streamArgs.runtimeContext = telemetryRuntimeContext
      }
      // Enable reasoning per provider (thinking budget / reasoning effort),
      // deep-merged onto any providerOptions the modelParams already carried
      // (e.g. the anthropic cacheControl breakpoint) so neither clobbers the
      // other.
      const reasoningOptions = buildReasoningProviderOptions(
        modelProtocol,
        creds.baseURL,
        req.reasoning,
        { providerId }
      )
      // Codex's own Responses-API fields (store:false + encrypted reasoning).
      // Merged after the reasoning block so both land under the `openai` key.
      const codexOptions =
        protocol === "openai"
          ? buildCodexResponsesProviderOptions({
              providerId,
              flavor: decideOpenAiEndpointFlavor({
                apiFlavor: creds.apiFlavor,
                baseURL: creds.baseURL,
                providerId,
              }),
              hasReasoning: reasoningOptions !== null,
            })
          : null
      const mergedProviderOptions = mergeProviderOptions(
        mergeProviderOptions(
          streamArgs.providerOptions as ProviderOptionsMap | undefined,
          reasoningOptions
        ),
        codexOptions
      )
      if (mergedProviderOptions) streamArgs.providerOptions = mergedProviderOptions
      // Forward the abort signal so an interrupt actually cancels the in-flight
      // provider HTTP request (cooperative `cancelled` flag alone let the call
      // run to completion and keep billing).
      if (req.abortSignal) streamArgs.abortSignal = req.abortSignal
      if (req.prepareStep) streamArgs.prepareStep = req.prepareStep
      // Router + Fusion ledgered call (ADR-0188): one reservation, one request.
      // Only set by the dispatcher for a reserved call, so it overrides a
      // provider-configured `modelParams.maxRetries` exactly then and never else.
      if (typeof req.maxRetries === "number") streamArgs.maxRetries = req.maxRetries
      if (req.tools && Object.keys(req.tools).length > 0) {
        streamArgs.tools = req.tools
        // Multi-step agentic loop: AI SDK runs each tool's `execute` and feeds
        // the result back to the model until it stops or we hit the step cap.
        // `req.stopWhenExtra(steps)` lets the caller end the leg EARLY after a
        // specific step (the ai-sdk path uses it to break right after a tool
        // returns an image, so the dispatcher can re-project that image as a
        // universally-supported user message before the model continues — most
        // non-Anthropic provider APIs can't carry an image inside a tool result).
        streamArgs.stopWhen = ({ steps }: { steps?: unknown[] }) =>
          (steps?.length ?? 0) >= (req.maxSteps ?? 16) ||
          (typeof req.stopWhenExtra === "function" ? req.stopWhenExtra(steps) === true : false)
      }
      // AI SDK 7 renamed the full event stream from `fullStream` to `stream`.
      // `fullStream` still exists as a deprecated alias, so returning the result
      // untouched would keep working — but only until the next major. Map it
      // explicitly instead, and keep `fullStream` as the name of OUR contract:
      // `types.ts` AdapterResult, `code-adapter.ts` and
      // `openai-compatible-variant-adapter.ts` all produce that field, and
      // `event-adapter.mjs` consumes it. This is the one place the SDK's name
      // and the internal name have to meet.
      const result = (await withTraceparent(req.traceparent, () =>
        streamTextFn(streamArgs)
      )) as StreamTextResultLike
      // SDK results expose lazy promise getters on their prototype. Spreading
      // the instance drops history/usage; eager reads create unhandled rejected
      // promises on interrupted streams. Preserve the adapter contract lazily.
      return {
        fullStream: (result.stream ?? result.fullStream)!,
        get responseMessages() {
          return result.responseMessages
        },
        get response() {
          return result.response
        },
        get usage() {
          return result.usage
        },
        get steps() {
          return result.steps
        },
      }
    },
  }
}
