/**
 * Single source of truth for "which model does the active provider actually
 * run with". Both the agent (via `to-build-context`) and the TUI display
 * (banner/footer/`/model` list) read this, so what the user sees always matches
 * what the sidecar dispatches.
 *
 * Precedence (per-provider memory is authoritative):
 *   1. the active provider's own remembered `model` (per-provider memory — what
 *      `/model` persists, and where `--model` / `COGNIA_MODEL` are routed)
 *   2. the provider's curated catalog default (shared `PROVIDERS` registry)
 *   3. an explicit top-level `config.model` — LAST resort only (an unknown
 *      provider with no catalog). A *persisted* top-level model is legacy and is
 *      deliberately NOT preferred, so a stale id from one provider (e.g. a Claude
 *      id) can never bleed into another provider that has its own default.
 *
 * Why per-provider beats top-level: a single global `config.model` pin bleeds
 * across providers — once you pick a Claude model it would show for DeepSeek,
 * OpenAI, etc. Keying the remembered model to the provider fixes that and lets
 * each provider reuse its own last-selected model. Returns `undefined` only when
 * none of the three yields a value, leaving the sidecar to pick its own default.
 */
import { catalogModelIds } from "@/lib/ai/model-options"

import type { ResolvedConfig } from "./schema"

export function resolveActiveModel(config: ResolvedConfig): string | undefined {
  const perProvider = config.providers[config.provider]?.model
  if (perProvider) return perProvider
  const catalogDefault = catalogModelIds(config.provider)[0]
  if (catalogDefault) return catalogDefault
  return config.model
}

/** True for the built-in sidecar backend (absent ⇒ built-in). Kept local so this
 * module stays importable from both the TUI and the plain `chat` path. */
function isBuiltinAgentBackend(backend: string | undefined): boolean {
  return !backend || backend === "builtin"
}

/**
 * Which model the *active backend* should actually run with.
 *
 * The built-in sidecar keeps {@link resolveActiveModel} unchanged. An external
 * agent is different in kind: it has its own model catalog and its own config
 * file, and the built-in provider's catalog default says nothing about it. So we
 * return **only** a model the user explicitly chose for that backend, and
 * `undefined` otherwise — which the caller must treat as "send no model", i.e.
 * let the agent use its own configuration (`~/.codex/config.toml` for Codex).
 *
 * This is the contract `runtime/backend-identity.ts` already documents ("show
 * what is true, or show nothing") and that a blanket `config.model` assignment
 * used to break: the built-in catalog default was both displayed as, and sent to
 * the external agent as, the model it was running — neither of which was true.
 *
 * Lookup prefers the resolved executable preset (`codex-app-server`) and falls
 * back to the id the user typed (`codex`), because the preset is only known once
 * the connect flow has probed for the native CLI.
 */
export function resolveBackendModel(config: ResolvedConfig, presetId?: string): string | undefined {
  const backend = config.agentBackend
  // Narrows `backend` to a string for the lookups below: the builtin guard has
  // already returned for both `undefined` and `"builtin"`.
  if (isBuiltinAgentBackend(backend)) return resolveActiveModel(config)
  const backends = config.agentBackends
  if (!backends) return undefined
  return (presetId ? backends[presetId]?.model : undefined) ?? backends[backend!]?.model
}
