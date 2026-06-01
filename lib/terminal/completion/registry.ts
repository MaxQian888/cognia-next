/**
 * Terminal completion provider registry.
 *
 * A module-level singleton (mirrors `lib/plugin/api/extension-api.ts`)
 * holding every registered completion provider — the two built-ins plus
 * any plugin-contributed ones. `getCompletions` fans the current context
 * out to all providers concurrently, isolates errors + slow providers
 * behind a per-provider timeout, then merges, dedupes, and ranks the
 * results (plugin > ai > history, then by score).
 *
 * Pure ranking lives in `rankSuggestions` so it's testable on its own.
 */

import {
  SOURCE_PRIORITY,
  type TerminalCompletionContext,
  type TerminalCompletionProvider,
  type TerminalCompletionSuggestion,
} from "./types"

const DEFAULT_PER_PROVIDER_TIMEOUT_MS = 4000
const DEFAULT_MAX = 6
const DEFAULT_SCORE = 0.5

const providers = new Map<string, TerminalCompletionProvider>()

/** Register (or replace by id) a completion provider. Returns a disposer. */
export function registerCompletionProvider(provider: TerminalCompletionProvider): () => void {
  providers.set(provider.id, provider)
  return () => {
    // Only delete if it's still the same instance — a later re-registration
    // under the same id must not be torn down by an older disposer.
    if (providers.get(provider.id) === provider) providers.delete(provider.id)
  }
}

/** All registered providers, ordered by ascending priority (default 100). */
export function listProviders(): TerminalCompletionProvider[] {
  return Array.from(providers.values()).sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))
}

/** Sort + dedupe suggestions: source priority, then score, then stable order. */
export function rankSuggestions(
  suggestions: TerminalCompletionSuggestion[]
): TerminalCompletionSuggestion[] {
  const sorted = [...suggestions].sort((a, b) => {
    const sp = SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source]
    if (sp !== 0) return sp
    return (b.score ?? DEFAULT_SCORE) - (a.score ?? DEFAULT_SCORE)
  })
  const seen = new Set<string>()
  const out: TerminalCompletionSuggestion[] = []
  for (const s of sorted) {
    if (seen.has(s.text)) continue
    seen.add(s.text)
    out.push(s)
  }
  return out
}

/** Run one provider with a child signal that aborts on parent abort or timeout. */
async function runProvider(
  provider: TerminalCompletionProvider,
  context: TerminalCompletionContext,
  parent: AbortSignal,
  timeoutMs: number
): Promise<TerminalCompletionSuggestion[]> {
  const child = new AbortController()
  const onParentAbort = () => child.abort()
  parent.addEventListener("abort", onParentAbort, { once: true })
  const timer = setTimeout(() => child.abort(), timeoutMs)
  try {
    const aborted = new Promise<TerminalCompletionSuggestion[]>((_, reject) => {
      child.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
    })
    const result = await Promise.race([provider.getCompletions(context, child.signal), aborted])
    return Array.isArray(result) ? result : []
  } catch {
    return []
  } finally {
    clearTimeout(timer)
    parent.removeEventListener("abort", onParentAbort)
  }
}

/**
 * Query every registered provider for the current context and return the
 * ranked, deduped, capped suggestion list. Never throws — provider errors
 * and timeouts degrade to "no result from that provider".
 */
export async function getCompletions(
  context: TerminalCompletionContext,
  signal: AbortSignal,
  opts: { perProviderTimeoutMs?: number; max?: number } = {}
): Promise<TerminalCompletionSuggestion[]> {
  if (signal.aborted) return []
  const timeoutMs = opts.perProviderTimeoutMs ?? DEFAULT_PER_PROVIDER_TIMEOUT_MS
  const max = opts.max ?? DEFAULT_MAX
  const all = await Promise.all(
    listProviders().map((p) => runProvider(p, context, signal, timeoutMs))
  )
  if (signal.aborted) return []
  return rankSuggestions(all.flat()).slice(0, max)
}

/** Test-only: clear the registry between cases. */
export function __resetCompletionRegistryForTesting(): void {
  providers.clear()
}
