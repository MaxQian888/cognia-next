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
import { resolveActiveModel } from "../../config/active-model"
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

export function backendIdentity(config: ResolvedConfig, presetId?: string): BackendIdentity {
  const backend = config.agentBackend
  if (isBuiltinBackend(backend)) {
    const model = resolveActiveModel(config)
    return { provider: config.provider, external: false, ...(model ? { model } : {}) }
  }
  // Prefer the preset actually launched: `codex` resolves to an executable
  // variant, and naming the variant is what makes `/doctor` and the banner agree.
  const provider =
    presetId && presetId !== backend ? `${backend} (${presetId})` : (backend as string)
  return {
    provider,
    external: true,
    // Only what we explicitly asked the agent to use. Absent means "the agent
    // chose", which is honest; the built-in catalog default would not be.
    ...(config.model ? { model: config.model } : {}),
  }
}

/** The compact form for the footer's `backend` segment. */
export function backendSegmentText(config: ResolvedConfig): string | null {
  const backend = config.agentBackend
  return isBuiltinBackend(backend) ? null : (backend as string)
}
