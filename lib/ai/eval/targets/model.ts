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
import type { EvalTarget } from "../runner"
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
  const model = deps.createModel({ ...resolution, model: config.modelId } as ResolvedProvider)
  const isLocal = isConfirmedLocalProvider(resolution)

  return {
    label: config.label,
    async run(evalCase, signal) {
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
      const startedAt = deps.now()
      const result = await deps.generateText({
        model,
        ...(system ? { system } : {}),
        messages: messages as never,
        abortSignal: signal,
        ...config.parameters,
      })
      const latencyMs = Math.max(0, deps.now() - startedAt)
      const inputTokens = Number(result.usage?.inputTokens ?? 0) || 0
      const outputTokens = Number(result.usage?.outputTokens ?? 0) || 0
      return {
        output: result.text,
        toolCalls: [],
        retrievedChunks: [],
        usage: {
          inputTokens,
          outputTokens,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
        costUsd: isLocal ? 0 : calculateCost(config.price, inputTokens, outputTokens),
        latencyMs,
        stepCount: 1,
        degraded: result.finishReason !== "stop" && result.finishReason !== "tool-calls",
        redactionPolicy: gated.policy,
        redactionDigest: await digestText(outboundText),
      }
    },
  }
}
