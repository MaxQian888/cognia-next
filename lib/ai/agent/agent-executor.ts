/**
 * Agent executor entrypoint.
 *
 * Plugins call `executeAgent(prompt, config)` to dispatch a one-shot
 * agent run. cognia-next's authoritative agent execution path is the
 * Claude SDK invocation in `lib/claude/`; the plugin surface is a thin
 * wrapper that lets plugins start an agent without needing a session.
 *
 * The current implementation routes through `streamText` with the
 * resolved provider — full agent loop / tool dispatch is the next
 * planned milestone. This shape stabilises the API so plugin code
 * does not need to change when the loop ships.
 */

import { streamText } from "ai"
import {
  createFeatureProviderModel,
  createProviderSettingsSnapshot,
  resolveFeatureProvider,
  type ProviderSettingsEntry,
  type CustomProviderDefinition,
} from "@/lib/ai/provider-consumption"

export interface AgentTool {
  /** Stable id; defaults to `name` when the caller omits it. */
  id?: string
  name: string
  description?: string
  schema?: Record<string, unknown>
  /**
   * Parameter definition consumed by the AI SDK's tool-calling layer.
   * Either a JSON-Schema literal or a Zod schema (the bridge converts
   * raw JSON Schema to Zod and forwards it as-is). Mirrors `schema` for
   * plugin authors who used the older field name; both are accepted,
   * `parameters` wins when set.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parameters?: Record<string, unknown> | any
  /**
   * When true, the host pauses before invoking the tool and asks the
   * user (or the permission guard) to approve. Plugin authors set this
   * for actions with side effects.
   */
  requiresApproval?: boolean
  /**
   * Tool implementation. Returns a JSON-serialisable result. The
   * runtime wraps non-Promise returns in `Promise.resolve()` so callers
   * can always `.then` / `.catch`.
   */
  execute: (input: Record<string, unknown>) => Promise<unknown>
}

export interface ExecuteAgentConfig {
  systemPrompt?: string
  model?: string
  tools?: AgentTool[]
  maxSteps?: number
  temperature?: number
  abortSignal?: AbortSignal
  /**
   * Provider snapshot inputs. When omitted, the executor falls back to
   * the user's default provider via the snapshot helpers — but the
   * caller must pass them in if they want a specific provider.
   */
  providerSettings?: Record<string, ProviderSettingsEntry>
  customProviders?: CustomProviderDefinition[]
  defaultProvider?: string
}

export interface ExecuteAgentResult {
  text: string
  finishReason?: string
}

export async function executeAgent(
  prompt: string,
  config: ExecuteAgentConfig = {}
): Promise<ExecuteAgentResult> {
  const snapshot = createProviderSettingsSnapshot({
    defaultProvider: config.defaultProvider,
    providerSettings: config.providerSettings,
    customProviders: config.customProviders,
  })

  const resolution = resolveFeatureProvider(
    {
      featureId: "plugin-agent-executor",
      routeProfile: "general-text",
      selectionMode: snapshot.defaultProvider ? "explicit-provider" : "any",
      providerId: snapshot.defaultProvider,
      fallbackMode: "first-eligible",
    },
    snapshot
  )

  if (resolution.kind !== "resolved") {
    throw new Error(`executeAgent: ${resolution.reason}`)
  }

  const model = createFeatureProviderModel({
    ...resolution,
    model: config.model ?? resolution.model,
  })

  const options: Record<string, unknown> = {
    model,
    prompt,
  }
  if (config.systemPrompt) options.system = config.systemPrompt
  if (config.temperature !== undefined) options.temperature = config.temperature
  if (config.abortSignal) options.abortSignal = config.abortSignal

  const result = streamText(options as Parameters<typeof streamText>[0])
  let text = ""
  for await (const chunk of result.textStream) {
    text += chunk
  }
  const finishReason = await result.finishReason
  return { text, finishReason: typeof finishReason === "string" ? finishReason : undefined }
}
