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
