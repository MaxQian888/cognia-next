/**
 * Resolve a Bot's configuration from its layers.
 *
 * Two rules, and they are deliberately different:
 *
 *   - An ORDINARY value takes the nearest layer that has one. A manual run's
 *     override beats the installation, which beats a repository file, which
 *     beats the definition's default.
 *   - A SECURITY value is not resolved here at all. Authority, autonomy,
 *     budget and scope go through `lib/bot/policy/ceilings.ts`, where the
 *     layers INTERSECT instead of overriding, so a nearer layer can only ever
 *     narrow. Running both kinds through one "nearest wins" resolver is how a
 *     run request ends up granting itself more than the organisation allows.
 *
 * The value shape is the shared `EffectiveValue`, the same one the IM facade
 * uses, so a Bot's settings panel can render provenance the way the
 * conversation override dialog already does.
 */

import type { EffectiveValue } from "@/lib/config/effective-value"

/** Which layer supplied a configuration value. */
export type BotConfigSource =
  /** An override passed with this particular run. */
  | "run-request"
  /** The installation row, which is where a user's settings live. */
  | "installation"
  /** A `.cognia` file in the repository the Bot is bound to. */
  | "repository"
  /** A `default` in the definition's `configSchema`. */
  | "definition-default"
  /** Nothing supplied a value. */
  | "unset"

export type EffectiveBotConfigValue<T = unknown> = EffectiveValue<T, BotConfigSource>

/** The layers, nearest the user first. Order IS the precedence. */
export const BOT_CONFIG_PRECEDENCE = [
  "run-request",
  "installation",
  "repository",
  "definition-default",
] as const

export interface BotConfigLayers {
  runRequest?: Record<string, unknown>
  installation?: Record<string, unknown>
  repository?: Record<string, unknown>
  definitionDefaults?: Record<string, unknown>
}

export interface ResolvedBotConfig {
  /** What the handler receives. Every key that any layer supplied. */
  values: Record<string, unknown>
  /** Per key, the winner and where it came from. */
  detail: Record<string, EffectiveBotConfigValue>
}

const LAYER_FIELD: Record<(typeof BOT_CONFIG_PRECEDENCE)[number], keyof BotConfigLayers> = {
  "run-request": "runRequest",
  installation: "installation",
  repository: "repository",
  "definition-default": "definitionDefaults",
}

/**
 * Read a definition's `configSchema` defaults.
 *
 * Only top-level `properties[].default`. A nested default is a schema feature
 * with no obvious precedence answer (does a nested object override key by key
 * or wholesale?), and guessing one would make the layering unpredictable.
 */
export function defaultsFromConfigSchema(
  schema: Record<string, unknown> | undefined
): Record<string, unknown> {
  const properties = schema?.properties
  if (!properties || typeof properties !== "object") return {}
  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(properties as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue
    const property = raw as { default?: unknown }
    if ("default" in property) out[key] = property.default
  }
  return out
}

/**
 * `undefined` means "this layer has no opinion". A layer that wants to clear a
 * value sets `null`, which wins like any other value, because otherwise there
 * is no way to unset something an outer layer supplied.
 */
function hasOpinion(layer: Record<string, unknown> | undefined, key: string): boolean {
  return layer !== undefined && key in layer && layer[key] !== undefined
}

export function resolveBotConfig(layers: BotConfigLayers): ResolvedBotConfig {
  const keys = new Set<string>()
  for (const source of BOT_CONFIG_PRECEDENCE) {
    const layer = layers[LAYER_FIELD[source]]
    if (layer) for (const key of Object.keys(layer)) keys.add(key)
  }

  const values: Record<string, unknown> = {}
  const detail: Record<string, EffectiveBotConfigValue> = {}

  for (const key of keys) {
    const requested = hasOpinion(layers.runRequest, key) ? layers.runRequest?.[key] : undefined
    let effective: unknown
    let source: BotConfigSource = "unset"

    for (const candidate of BOT_CONFIG_PRECEDENCE) {
      const layer = layers[LAYER_FIELD[candidate]]
      if (!hasOpinion(layer, key)) continue
      effective = layer?.[key]
      source = candidate
      break
    }

    values[key] = effective
    detail[key] = { requested, effective, source }
  }

  return { values, detail }
}
