/**
 * Build the `/model` switcher's option list for the ACTIVE provider, reusing the
 * desktop's curated model catalog (`catalogModelIds` over the shared `PROVIDERS`
 * registry) so the CLI and app agree and a provider switch yields the right
 * list. The list is scoped strictly to the active provider — it mirrors
 * `resolveActiveModel`'s precedence so another provider's remembered model
 * (e.g. a Claude id pinned under Anthropic) never bleeds into, say, DeepSeek's
 * picker. Pure.
 */
import { catalogModelIds, resolveModelDisplayName } from "@/lib/ai/model-options"
import { PROVIDERS } from "@cognia/provider-types/provider"
import type { ProviderModelDiscoveryEntry } from "@cognia/provider-types/provider"
import { getCachedOpenRouterCatalogModels } from "@cognia/provider-core/providers/openrouter-catalog-sync"

import type { ResolvedConfig } from "../../config/schema"

/** Synced OpenRouter catalog entry for `modelId`, from the primed in-memory cache
 * (populated at TUI boot by the openrouter-catalog controller). Used to enrich a
 * `/model` row whose id the static `PROVIDERS.openrouter` subset doesn't carry. */
function openRouterCatalogEntry(modelId: string): ProviderModelDiscoveryEntry | undefined {
  return getCachedOpenRouterCatalogModels().find((m) => m.id === modelId)
}

/**
 * Friendly label for one `/model` row: "<display name> · <id>" when the shared
 * catalog knows a distinct human-readable name for the id, else the bare id.
 * The overlay still selects by id (its option list is unchanged ids) — this only
 * affects what the row renders, closing the id-only readability gap in the TUI.
 */
export function formatModelOptionLabel(modelId: string, providerId: string): string {
  const name = resolveModelDisplayName(providerId, modelId)
  return name && name !== modelId ? `${name} · ${modelId}` : modelId
}

/** Compact "200K" / "1M" context-window label. */
function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const v = tokens / 1_000_000
    return `${Number.isInteger(v) ? v : v.toFixed(1)}M`
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`
  return String(tokens)
}

/**
 * Secondary "hint" line for a `/model` row: the model's context window and a
 * short capability summary (reasoning / tools / vision) pulled from the shared
 * static catalog. Returns `undefined` when the catalog carries no metadata for
 * the id (custom / discovered ids), so the row falls back to just its label.
 */
export function modelInfoHint(modelId: string, providerId: string): string | undefined {
  // The static catalog is the primary metadata source; for OpenRouter, whose
  // full list comes from the synced catalog, fall back to the catalog entry so a
  // live-synced model still shows its context window + capabilities.
  const m =
    PROVIDERS[providerId]?.models?.find((x) => x.id === modelId) ??
    (providerId === "openrouter" ? openRouterCatalogEntry(modelId) : undefined)
  if (!m) return undefined
  const parts: string[] = []
  if (typeof m.contextLength === "number" && m.contextLength > 0) {
    parts.push(formatContextWindow(m.contextLength))
  }
  const caps: string[] = []
  if (m.supportsReasoning) caps.push("reasoning")
  if (m.supportsTools) caps.push("tools")
  if (m.supportsVision) caps.push("vision")
  if (caps.length > 0) parts.push(caps.join(", "))
  return parts.length > 0 ? parts.join(" · ") : undefined
}

export function collectModelOptions(config: ResolvedConfig): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const add = (m: string | undefined) => {
    if (m && !seen.has(m)) {
      seen.add(m)
      out.push(m)
    }
  }
  // Scope strictly to the active provider, mirroring `resolveActiveModel`:
  //   1. the active provider's own remembered model (what `/model` persists)
  //   2. that provider's curated catalog
  // This is what makes a `/provider` switch surface the correct model list and
  // stops a stale top-level pin (or another provider's model) from leaking in.
  add(config.providers[config.provider]?.model)
  for (const id of catalogModelIds(config.provider)) add(id)
  // OpenRouter's full real-time list lives in the synced catalog (Dexie v93,
  // shared with the GUI and primed at TUI boot), not the static `PROVIDERS`
  // subset — fold every catalogued id in so `/model` reflects the live `/models`
  // list. Empty until the first sync, so it degrades to the curated subset above.
  if (config.provider === "openrouter") {
    for (const m of getCachedOpenRouterCatalogModels()) add(m.id)
  }
  // Uncatalogued provider with no per-provider memory: the legacy top-level
  // model is all we know — surface it so an enabled provider never renders an
  // empty list. (Matches `resolveActiveModel`'s last-resort fallback.)
  if (out.length === 0) add(config.model)
  return out
}
