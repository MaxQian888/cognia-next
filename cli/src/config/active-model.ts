/**
 * Single source of truth for "which model does the active provider actually
 * run with". Both the agent (via `to-build-context`) and the TUI display
 * (banner/footer/`/model` list) read this, so what the user sees always matches
 * what the sidecar dispatches.
 *
 * Precedence:
 *   1. an explicit top-level `config.model` (user pinned a model)
 *   2. the active provider's own configured `model` (per-provider default)
 *   3. the provider's curated catalog default (shared `PROVIDERS` registry)
 *
 * The catalog fallback is what stops a stale model id from a previous provider
 * (e.g. a Claude id left over after switching to DeepSeek) — or no model at all
 * — from reaching a provider that won't serve it. Returns `undefined` only when
 * none of the three yields a value (an unknown provider with no configuration),
 * leaving the sidecar to pick its own default.
 */
import { catalogModelIds } from "@/lib/ai/model-options"

import type { ResolvedConfig } from "./schema"

export function resolveActiveModel(config: ResolvedConfig): string | undefined {
  if (config.model) return config.model
  const perProvider = config.providers[config.provider]?.model
  if (perProvider) return perProvider
  return catalogModelIds(config.provider)[0]
}
