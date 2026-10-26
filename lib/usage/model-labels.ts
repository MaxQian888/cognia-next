/**
 * The names a usage dashboard shows for the models in its rows.
 *
 * Usage rows key models by id (`aggregateByModel`, `topModelByTokens`), which
 * is right for bucketing and wrong for reading: a member of an org saw
 * `ark-deepseek-v4.1-flash` on the welcome dashboard while the model menu
 * beside it said "DeepSeek V4.1 Flash". The label follows the model menu's
 * order (`components/chat/composer/model-picker.tsx`): the name the org's
 * deployment gives the model, else this app's own catalog name for it
 * (`resolveModelDisplayName`), else its id. The id stays the key everywhere.
 *
 * Pure: the caller passes the member's org names and its provider settings.
 */

import type { CustomProviderSettings, UserProviderSettings } from "@cognia/provider-types/provider"
import { resolveModelDisplayName } from "@/lib/ai/model-options"
import type { SessionUsageRow } from "@/lib/db/session-usage"

/** The bucket `aggregateByModel` files a row without a model id under. */
export const UNKNOWN_MODEL_KEY = "(unknown)"

/** An org deployment's model names, by provider then model id. */
export type OrgModelNames = Readonly<Record<string, Readonly<Record<string, string>>>>

export interface ModelLabelContext {
  orgNames?: OrgModelNames | null
  providerSettings?: Record<string, UserProviderSettings>
  customProviders?: CustomProviderSettings[]
}

/**
 * The provider each model key's tokens mostly came from, keyed as
 * `aggregateByModel` keys its buckets. One id served by two providers takes
 * the provider that moved more of its tokens (ties: the alphabetically first).
 */
export function modelProviders(rows: readonly SessionUsageRow[]): Map<string, string> {
  const tokens = new Map<string, Map<string, number>>()
  for (const row of rows) {
    const model = row.model?.trim() || UNKNOWN_MODEL_KEY
    const provider = row.providerId?.trim()
    if (!provider) continue
    const byProvider = tokens.get(model) ?? new Map<string, number>()
    byProvider.set(
      provider,
      (byProvider.get(provider) ?? 0) + row.inputTokens + row.outputTokens + row.cacheReadTokens
    )
    tokens.set(model, byProvider)
  }
  const out = new Map<string, string>()
  for (const [model, byProvider] of tokens) {
    const [provider] = [...byProvider.entries()].sort(
      ([a, aTokens], [b, bTokens]) => bTokens - aTokens || a.localeCompare(b)
    )[0]
    out.set(model, provider)
  }
  return out
}

/**
 * The label for one model key, or `null` for the unknown bucket (the caller
 * names it in the reader's language).
 */
export function usageModelLabel(
  model: string,
  providerId: string | undefined,
  context: ModelLabelContext = {}
): string | null {
  if (model === UNKNOWN_MODEL_KEY) return null
  const orgName = providerId ? context.orgNames?.[providerId]?.[model]?.trim() : undefined
  if (orgName) return orgName
  return resolveModelDisplayName(
    providerId,
    model,
    context.providerSettings,
    context.customProviders
  )
}

/** Labels for every model key in `rows`, as {@link usageModelLabel} gives them. */
export function usageModelLabels(
  rows: readonly SessionUsageRow[],
  context: ModelLabelContext = {}
): Record<string, string | null> {
  const providers = modelProviders(rows)
  const out: Record<string, string | null> = {}
  for (const row of rows) {
    const model = row.model?.trim() || UNKNOWN_MODEL_KEY
    if (model in out) continue
    out[model] = usageModelLabel(model, providers.get(model), context)
  }
  return out
}
