/**
 * TUI boot hook for the OpenRouter live-models catalog (Dexie v93). The CLI
 * analogue of the desktop `OpenRouterCatalogInitializer`: it opens the shared
 * CLI-local db, primes the in-memory catalog cache from the persisted row, and
 * background-refreshes from the live `/models` API when missing/stale (>24h).
 *
 * Once primed, the synchronous `/model` picker (`collectModelOptions`) reflects
 * the full real-time OpenRouter catalog — the same row the desktop GUI syncs.
 *
 * Only invoked when OpenRouter is the active provider, so a user who never
 * touches OpenRouter pays no network cost. All effects are injectable so the
 * controller unit-tests without a real db or network.
 */
import { ensureCliDb } from "../../db/bootstrap"
import { refreshOpenRouterCatalogIfStale } from "@/lib/ai/providers/openrouter-catalog-sync"

export interface InitOpenRouterCatalogOptions {
  /** Optional OpenRouter API key (account models); keyless fetches the full
   * public catalog, which is the default. */
  apiKey?: string
  // ── Injected seams (tests) ──────────────────────────────────────────────────
  ensureDb?: () => Promise<unknown>
  refresh?: (maxAgeMs?: number, now?: number, apiKey?: string) => Promise<unknown>
}

/**
 * Open the CLI db, then prime + (if stale) refresh the OpenRouter catalog. Never
 * throws — a db/network failure leaves the (possibly empty) cache in place and
 * the picker degrades to the static `PROVIDERS.openrouter` subset.
 */
export async function initOpenRouterCatalog(
  opts: InitOpenRouterCatalogOptions = {}
): Promise<void> {
  const ensureDb = opts.ensureDb ?? (() => ensureCliDb())
  const refresh = opts.refresh ?? refreshOpenRouterCatalogIfStale
  try {
    await ensureDb()
    await refresh(undefined, undefined, opts.apiKey)
  } catch {
    // Non-fatal: a missing/locked db or an offline refresh just leaves the
    // catalog cache untouched; the picker still works off the static subset.
  }
}
