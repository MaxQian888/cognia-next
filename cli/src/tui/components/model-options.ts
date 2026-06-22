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

import type { ResolvedConfig } from "../../config/schema"

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
  const m = PROVIDERS[providerId]?.models?.find((x) => x.id === modelId)
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
  // Uncatalogued provider with no per-provider memory: the legacy top-level
  // model is all we know — surface it so an enabled provider never renders an
  // empty list. (Matches `resolveActiveModel`'s last-resort fallback.)
  if (out.length === 0) add(config.model)
  return out
}
