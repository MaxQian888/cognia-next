/**
 * Who is actually answering.
 *
 * The banner, the footer and `/status` all used to render `config.provider` and
 * the active provider's catalog model. On an external backend both are wrong in
 * the worst way — `--backend codex` displayed "anthropic · claude-opus-4-8"
 * while Codex answered — and the fullscreen layout pins that line on screen for
 * the whole session.
 *
 * The rule here is the same one the capability gate follows: show what is true,
 * or show nothing. An external agent that was never told which model to use
 * picks its own, and the built-in provider's catalog default is not a stand-in
 * for it, so the model is simply omitted.
 */
import { getModelContextWindow } from "@/lib/claude/usage"
import { providerIdForPreset } from "@/lib/ai/agent/external/preset-provider"

import { resolveBackendModel } from "../../config/active-model"
import type { ResolvedConfig } from "../../config/schema"
import { isBuiltinBackend } from "./backend-capabilities"

export interface BackendIdentity {
  /** Rendered where the provider used to go — the backend id when external. */
  provider: string
  /** The model, when one is genuinely known. */
  model?: string
  /** True when an external agent answers this session. */
  external: boolean
}

/** Provider/model pair whose metadata belongs to the backend actually running. */
export function backendModelMetaTarget(
  config: ResolvedConfig,
  presetId?: string
): { provider: string; model?: string } {
  const model = resolveBackendModel(config, presetId)
  if (isBuiltinBackend(config.agentBackend)) {
    return { provider: config.provider, ...(model ? { model } : {}) }
  }
  const backendId = presetId ?? config.agentBackend
  const provider = providerIdForPreset(backendId) ?? backendId ?? config.provider
  return { provider, ...(model ? { model } : {}) }
}

export function backendIdentity(config: ResolvedConfig, presetId?: string): BackendIdentity {
  const backend = config.agentBackend
  // One resolver for both branches. `resolveBackendModel` reads the built-in
  // provider's own memory on the built-in agent and the per-backend memory
  // (`agentBackends[presetId ?? backend]`) on an external one — so the question
  // asked here is always "what did we tell THIS backend to run".
  //
  // Reading the top-level `config.model` instead (as this did) made the answer
  // depend on someone else having normalised that field first: it is a legacy
  // global pin that still carries the built-in provider's leftover id, so
  // `--backend codex` could render an Anthropic model as Codex's. Only what we
  // explicitly asked the agent to use belongs here; absent means "the agent
  // chose", which is honest, while the built-in catalog default would not be.
  const model = resolveBackendModel(config, presetId)
  if (isBuiltinBackend(backend)) {
    return { provider: config.provider, external: false, ...(model ? { model } : {}) }
  }
  // Prefer the preset actually launched: `codex` resolves to an executable
  // variant, and naming the variant is what makes `/doctor` and the banner agree.
  const provider =
    presetId && presetId !== backend ? `${backend} (${presetId})` : (backend as string)
  return {
    provider,
    external: true,
    ...(model ? { model } : {}),
  }
}

/**
 * The context window this backend's usage may honestly be scored against, or
 * `undefined` when no such number exists.
 *
 * `contextWindow` — the per-model window the session resolved from the models
 * catalog — wins whenever it is positive. Without it we may only fall back to
 * the pattern table in `lib/claude/usage`, and that table describes the models
 * the built-in agent drives; it says nothing about an external agent's model and
 * silently answers 128k for anything it does not recognise. Deriving a `% ctx`
 * from that on an external backend invents a fact, which is exactly what
 * `externalWithoutKnownWindow` (format/status-bar) already refuses to do in the
 * footer — so `/status` and `/context` route through here and print nothing
 * instead.
 */
export function backendContextWindow(
  config: ResolvedConfig,
  contextWindow?: number,
  presetId?: string
): number | undefined {
  if (contextWindow && contextWindow > 0) return contextWindow
  if (!isBuiltinBackend(config.agentBackend)) return undefined
  return getModelContextWindow(resolveBackendModel(config, presetId))
}

/** The compact form for the footer's `backend` segment. */
export function backendSegmentText(config: ResolvedConfig): string | null {
  const backend = config.agentBackend
  return isBuiltinBackend(backend) ? null : (backend as string)
}
