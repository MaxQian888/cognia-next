import { generateText as aiGenerateText } from "ai"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { applyPiiGate } from "@/lib/workflow/nodes/ai/pii-gate"
import {
  createFeatureProviderModel,
  createProviderSettingsSnapshot,
  resolveFeatureProvider,
  type ProviderSettingsSnapshotInput,
  type ResolvedProvider,
} from "@/lib/ai/provider-consumption"
import type { EvalCase, EvalInputPart, EvalSample } from "@/types/eval/eval"
import type { EvalTarget } from "@cognia/eval-core"
import { isConfirmedLocalProvider } from "../provider-locality"

const PART_SEPARATOR = "\u001eCOGNIA_EVAL_PART\u001e"

export interface PureModelEvalTargetConfig {
  label: string
  providerId: string
  modelId: string
  isLocal: boolean
  price?: { inputPerMillion: number; outputPerMillion: number; currency: string }
  settings: ProviderSettingsSnapshotInput
  systemPrompt?: string
  /** Local evidence observer, after the final PII gate and before dispatch. */
  onPreparedTextParts?(parts: readonly string[]): void
  /** Explicit reasoning control for OpenAI-compatible benchmark endpoints. */
  reasoningEffort?: "low" | "medium" | "high"
  parameters?: {
    temperature?: number
    topP?: number
    maxOutputTokens?: number
  }
}

export interface PureModelEvalTargetDeps {
  createSnapshot: typeof createProviderSettingsSnapshot
  resolveProvider: typeof resolveFeatureProvider
  createModel: typeof createFeatureProviderModel
  generateText: typeof aiGenerateText
  resolveAsset(assetId: string): Promise<{ data: string | Uint8Array; mediaType: string }>
  now(): number
}

const defaultDeps: PureModelEvalTargetDeps = {
  createSnapshot: createProviderSettingsSnapshot,
  resolveProvider: resolveFeatureProvider,
  createModel: createFeatureProviderModel,
  generateText: aiGenerateText,
  resolveAsset: async (assetId) => {
    throw new Error(`Evaluation asset ${assetId} is unavailable`)
  },
  now: () => performance.now(),
}

async function digestText(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const hash = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  )
  return `sha256:${Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`
}

function caseParts(evalCase: EvalCase): EvalInputPart[] {
  return evalCase.contentParts?.length
    ? evalCase.contentParts
    : [{ type: "text", text: evalCase.input }]
}

function gatedTextParts(
  values: string[],
  isLocal: boolean
): { values: string[]; policy: EvalSample["redactionPolicy"] } {
  if (isLocal) return { values, policy: "local-original" }
  const gated = applyPiiGate("redact", { user: values.join(PART_SEPARATOR) })
  return { values: gated.user.split(PART_SEPARATOR), policy: "cloud-redacted" }
}

function calculateCost(
  price: PureModelEvalTargetConfig["price"],
  inputTokens: number,
  outputTokens: number
): number {
  if (!price) return 0
  return (inputTokens * price.inputPerMillion + outputTokens * price.outputPerMillion) / 1_000_000
}

function hasKnownPrice(price: PureModelEvalTargetConfig["price"]): boolean {
  return Boolean(
    price &&
    price.currency.toUpperCase() === "USD" &&
    Number.isFinite(price.inputPerMillion) &&
    price.inputPerMillion >= 0 &&
    Number.isFinite(price.outputPerMillion) &&
    price.outputPerMillion >= 0
  )
}

export function createPureModelEvalTarget(
  config: PureModelEvalTargetConfig,
  overrides: Partial<PureModelEvalTargetDeps> = {}
): EvalTarget {
  const deps = { ...defaultDeps, ...overrides }
  const snapshot = deps.createSnapshot(config.settings)
  const resolution = deps.resolveProvider(
    {
      featureId: "eval.pure-model",
      routeProfile: "capability-bound",
      selectionMode: "explicit-provider",
      providerId: config.providerId,
      fallbackMode: "none",
      executionMode: "direct-model",
      proxyMode: "never",
    },
    snapshot
  )
  if (resolution.kind !== "resolved") {
    throw new Error(resolution.reason || `Evaluation provider ${config.providerId} is unavailable`)
  }
  if (config.reasoningEffort && resolution.protocol !== "openai")
    throw new Error("Explicit evaluation reasoning effort requires an OpenAI-compatible provider")
  const model = deps.createModel({ ...resolution, model: config.modelId } as ResolvedProvider)
  // A caller may require cloud redaction for a loopback forwarding proxy.
  // A true flag still cannot bypass endpoint verification.
  const isLocal = config.isLocal && isConfirmedLocalProvider(resolution)

  return {
    label: config.label,
    async run(evalCase, signal) {
      const startedAt = deps.now()
      const parts = caseParts(evalCase)
      if (
        !isLocal &&
        parts.some((part) => part.type === "asset" && part.privacy === "local-only")
      ) {
        throw new Error("Cloud evaluation media requires privacy clearance")
      }

      const historyText = (evalCase.history ?? []).map((turn) => turn.content)
      const partText = parts.flatMap((part) => (part.type === "text" ? [part.text] : []))
      const systemText = config.systemPrompt ? [config.systemPrompt] : []
      const gated = gatedTextParts([...systemText, ...historyText, ...partText], isLocal)
      let cursor = 0
      const system = config.systemPrompt ? gated.values[cursor++] : undefined
      const history = (evalCase.history ?? []).map((turn) => ({
        role: turn.role,
        content: gated.values[cursor++],
      }))
      const userContent: Array<Record<string, unknown>> = []
      for (const part of parts) {
        if (part.type === "text") {
          userContent.push({ type: "text", text: gated.values[cursor++] })
          continue
        }
        const asset = await deps.resolveAsset(part.assetId)
        userContent.push(
          asset.mediaType.startsWith("image/")
            ? { type: "image", image: asset.data, mediaType: asset.mediaType }
            : {
                type: "file",
                data: asset.data,
                mediaType: asset.mediaType,
                ...(part.name ? { filename: part.name } : {}),
              }
        )
      }
      const messages = [
        ...history,
        {
          role: "user" as const,
          content:
            userContent.length === 1 && userContent[0].type === "text"
              ? String(userContent[0].text)
              : userContent,
        },
      ]
      const outboundText = [system ?? "", ...gated.values.slice(systemText.length)].join("\n")
      if (!hasNoLeakingPiiDeep({ system, messages })) {
        throw new Error("Evaluation payload failed the PII redaction gate")
      }
      config.onPreparedTextParts?.(
        Object.freeze(gated.values.slice(systemText.length + historyText.length))
      )
      const result = await deps.generateText({
        model,
        ...(system ? { system } : {}),
        messages: messages as never,
        abortSignal: signal,
        ...config.parameters,
        ...(config.reasoningEffort
          ? { providerOptions: { openai: { reasoningEffort: config.reasoningEffort } } }
          : {}),
        // Retries belong to the eval runner so each billable attempt is visible.
        maxRetries: 0,
      })
      const latencyMs = Math.max(0, deps.now() - startedAt)
      const inputKnown =
        typeof result.usage?.inputTokens === "number" &&
        Number.isFinite(result.usage.inputTokens) &&
        result.usage.inputTokens >= 0
      const outputKnown =
        typeof result.usage?.outputTokens === "number" &&
        Number.isFinite(result.usage.outputTokens) &&
        result.usage.outputTokens >= 0
      const usageKnown = inputKnown && outputKnown
      const inputTokens = inputKnown ? result.usage.inputTokens! : 0
      const outputTokens = outputKnown ? result.usage.outputTokens! : 0
      const cacheCount = (value: unknown) =>
        typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0
      const priceKnown = hasKnownPrice(config.price)
      return {
        output: result.text,
        toolCalls: [],
        retrievedChunks: [],
        usage: {
          inputTokens,
          outputTokens,
          cacheReadTokens: cacheCount(result.usage?.inputTokenDetails?.cacheReadTokens),
          cacheCreationTokens: cacheCount(result.usage?.inputTokenDetails?.cacheWriteTokens),
        },
        // A loopback endpoint may forward to a billable cloud model. Endpoint
        // locality never establishes a zero price.
        costUsd: priceKnown ? calculateCost(config.price, inputTokens, outputTokens) : 0,
        latencyMs,
        stepCount: 1,
        degraded: result.finishReason !== "stop" && result.finishReason !== "tool-calls",
        executionStatus: result.finishReason === "error" ? "failed" : "completed",
        executionProfile: "pure-model",
        metricAvailability: {
          usage: usageKnown ? "known" : inputKnown || outputKnown ? "partial" : "unavailable",
          cost:
            priceKnown && usageKnown
              ? "estimated"
              : priceKnown && (inputKnown || outputKnown)
                ? "partial"
                : "unavailable",
          latency: "known",
          steps: "known",
        },
        ...(result.finishReason === "error"
          ? { error: "Evaluation model returned an error finish reason" }
          : {}),
        redactionPolicy: gated.policy,
        redactionDigest: await digestText(outboundText),
      }
    },
  }
}
