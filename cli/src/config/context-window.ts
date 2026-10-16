/**
 * The context window a user declared for a model in `config.providers`, for
 * models no catalog knows (a self-hosted or proxied id). Every place that
 * sizes the window reads it first: the TUI's model meta (`/context`, footer),
 * the backend fallback, and the sidecar's compaction budget (forwarded as
 * provider model metadata by `to-build-context`).
 */
import type { ResolvedConfig } from "./schema"

/** `providers[provider].models[model].contextWindow`, else the provider-wide value. */
export function configuredContextWindow(
  config: Pick<ResolvedConfig, "providers">,
  provider: string | undefined,
  model: string | undefined
): number | undefined {
  if (!provider) return undefined
  const entry = config.providers[provider]
  if (!entry) return undefined
  const perModel = model ? entry.models?.[model]?.contextWindow : undefined
  return perModel ?? entry.contextWindow
}

/**
 * Every model of a provider with a declared window, as `{ id, contextLength }`
 * rows. `activeModel` is included when only the provider-wide value applies,
 * since a model id need not be listed to run.
 */
export function declaredModelWindows(
  config: Pick<ResolvedConfig, "providers">,
  provider: string,
  activeModel?: string
): Array<{ id: string; contextLength: number }> {
  const entry = config.providers[provider]
  if (!entry) return []
  const ids = new Set<string>(Object.keys(entry.models ?? {}))
  if (entry.model) ids.add(entry.model)
  if (activeModel) ids.add(activeModel)
  const rows: Array<{ id: string; contextLength: number }> = []
  for (const id of ids) {
    const contextLength = configuredContextWindow(config, provider, id)
    if (contextLength) rows.push({ id, contextLength })
  }
  return rows
}
