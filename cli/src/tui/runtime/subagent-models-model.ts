/**
 * Pure presentation + edit model for the `/agents models` panel — the settings
 * surface that assigns a provider/model to each dispatchable subagent.
 *
 * It joins three sources into one ordered row list: the discovered subagents
 * (their markdown `model`/`provider` frontmatter), the user's persisted
 * `config.subagentModels` overrides, and the active provider's curated model
 * catalog (for the ←/→ cycle). Ink-free + I/O-free, so the join/cycle logic
 * unit-tests without a render — the App layer renders {@link SubagentModelRow}s
 * and persists the {@link SubagentModelOverride} (or `null`) each edit returns.
 */
import { catalogModelIds } from "@/lib/ai/model-options"

import type { AgentSummary } from "../../agent/discover-agents"
import type { ResolvedConfig, SubagentModelOverride } from "../../config/schema"

/** The cycle sentinel shown at the head of every model list — selecting it
 * clears the override (back to inherit). Never persisted. */
export const SUBAGENT_MODEL_INHERIT = "(inherit)"

/** One row in the `/agents models` panel — a fully-resolved view of one
 * subagent's effective provider/model plus the choices the user can cycle. */
export interface SubagentModelRow {
  id: string
  name: string
  description: string
  /** Where the effective model comes from: an explicit override, the agent's
   * markdown frontmatter, or pure inheritance (active provider default). */
  source: "override" | "frontmatter" | "inherit"
  /** Effective provider id currently in effect for this subagent. */
  provider: string
  /** Effective model id; `undefined` ⇒ the provider's default model. */
  model?: string
  /** True when the provider is purely the active default (no override / no
   * frontmatter provider) — drives whether a model edit pins the provider too. */
  inheritsProvider: boolean
  /** Configured provider ids the user can cycle through (the `p` key). */
  providerOptions: string[]
  /** Model ids available for {@link provider} (catalog), for ←/→ cycling. */
  modelOptions: string[]
  /** The agent's markdown frontmatter `model` (the inherit fallback). Kept so
   * the row can be recomputed against fresh config without re-discovery. */
  frontmatterModel?: string
  /** The agent's markdown frontmatter `provider`. */
  frontmatterProvider?: string
}

/** The minimal agent shape the row computation needs — lets a row be rebuilt
 * from its own stored frontmatter (no async re-discovery on each edit). */
interface SubagentLike {
  id: string
  name: string
  description: string
  frontmatterModel?: string
  frontmatterProvider?: string
}

/** Configured provider ids, with the active provider guaranteed first/present. */
function providerChoices(config: ResolvedConfig): string[] {
  const ids = new Set<string>([config.provider, ...Object.keys(config.providers)])
  return [...ids]
}

/** Model catalog for a provider, with `effective` surfaced even when the static
 * catalog doesn't know it (a discovered / hand-pinned id), so the cycle always
 * contains the current value. */
function modelChoices(provider: string, effective: string | undefined): string[] {
  const catalog = catalogModelIds(provider)
  if (effective && !catalog.includes(effective)) return [effective, ...catalog]
  return catalog
}

/** Project one subagent into a fully-resolved row against the live config. */
function computeRow(
  agent: SubagentLike,
  config: ResolvedConfig,
  providerOptions: string[]
): SubagentModelRow {
  const ov = config.subagentModels?.[agent.id]
  const fmProvider = agent.frontmatterProvider
  const fmModel = agent.frontmatterModel
  const provider = ov?.provider ?? fmProvider ?? config.provider
  let model: string | undefined
  if (ov?.model) model = ov.model
  else if (ov?.provider)
    model = undefined // provider-only override ⇒ provider default
  else model = fmModel
  const source: SubagentModelRow["source"] = ov ? "override" : fmModel ? "frontmatter" : "inherit"
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    source,
    provider,
    ...(model ? { model } : {}),
    inheritsProvider: !ov?.provider && !fmProvider,
    providerOptions,
    modelOptions: modelChoices(provider, model),
    ...(fmModel ? { frontmatterModel: fmModel } : {}),
    ...(fmProvider ? { frontmatterProvider: fmProvider } : {}),
  }
}

/** Build the panel rows from the discovered (frontmatter) agents + config. The
 * `agents` MUST be the raw discovered set (overrides NOT yet overlaid) so the
 * row can distinguish an override from frontmatter. Sorted by display name. */
export function buildSubagentModelRows(
  agents: AgentSummary[],
  config: ResolvedConfig
): SubagentModelRow[] {
  const providerOptions = providerChoices(config)
  const rows = agents.map((a) =>
    computeRow(
      {
        id: a.id,
        name: a.name,
        description: a.description,
        ...(a.def.model ? { frontmatterModel: a.def.model } : {}),
        ...(a.def.provider ? { frontmatterProvider: a.def.provider } : {}),
      },
      config,
      providerOptions
    )
  )
  return rows.sort((x, y) => x.name.localeCompare(y.name))
}

/** Recompute existing rows against fresh config (after an edit) — uses each
 * row's stored frontmatter, so no async re-discovery is needed. Order (already
 * name-sorted) is preserved so the cursor doesn't jump. */
export function recomputeSubagentModelRows(
  rows: SubagentModelRow[],
  config: ResolvedConfig
): SubagentModelRow[] {
  const providerOptions = providerChoices(config)
  return rows.map((r) =>
    computeRow(
      {
        id: r.id,
        name: r.name,
        description: r.description,
        ...(r.frontmatterModel ? { frontmatterModel: r.frontmatterModel } : {}),
        ...(r.frontmatterProvider ? { frontmatterProvider: r.frontmatterProvider } : {}),
      },
      config,
      providerOptions
    )
  )
}

/** Wrap an index into `[0, len)`. */
function wrap(i: number, len: number): number {
  if (len <= 0) return 0
  return ((i % len) + len) % len
}

/**
 * The override to persist when the user cycles a row's MODEL by `delta`.
 * Returns `null` to reset (the inherit sentinel). A model edit keeps the row's
 * effective provider, pinning it only when the provider isn't the pure active
 * default (so a plain model swap doesn't strand the agent on today's provider).
 */
export function cycleSubagentModel(
  row: SubagentModelRow,
  delta: number
): SubagentModelOverride | null {
  const cycle = [SUBAGENT_MODEL_INHERIT, ...row.modelOptions]
  const at = row.model ? cycle.indexOf(row.model) : 0
  const next = cycle[wrap((at < 0 ? 0 : at) + delta, cycle.length)]
  if (!next || next === SUBAGENT_MODEL_INHERIT) return null
  return row.inheritsProvider ? { model: next } : { provider: row.provider, model: next }
}

/**
 * The override to persist when the user cycles a row's PROVIDER by `delta`.
 * Always explicit (provider + that provider's default model when the catalog
 * knows one), so switching provider takes a model the new provider can serve.
 */
export function cycleSubagentProvider(row: SubagentModelRow, delta: number): SubagentModelOverride {
  const opts = row.providerOptions
  const at = opts.indexOf(row.provider)
  const provider = opts[wrap((at < 0 ? 0 : at) + delta, opts.length)] ?? row.provider
  const defaultModel = catalogModelIds(provider)[0]
  return defaultModel ? { provider, model: defaultModel } : { provider }
}

/** Footer hint for the panel. */
export const SUBAGENT_MODELS_FOOTER = "↑/↓ move · ←/→ model · p provider · r reset · esc close"
