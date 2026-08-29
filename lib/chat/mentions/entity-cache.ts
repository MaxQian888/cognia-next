/**
 * Per-context read cache for the composer's `@` entity panel.
 *
 * The panel's sources are list-shaped: `@memory:` / `@issue:` / `@chat:` /
 * `@artifact:` each read their whole store and filter in memory. Before this,
 * that read ran on EVERY keystroke past the 120 ms debounce — `listSessions()`
 * pulls every full session row (`branchSeed.content` included, up to 24k chars
 * each), `listMemories()` is a full table cursor with a JS predicate — and the
 * lowercased haystack was rebuilt per row per keystroke on top of it.
 *
 * ⌘K already solved exactly this with `lib/global-search/cache.ts`
 * (`createSearchCache`: 15 s TTL, in-flight sharing, one registry cleared when
 * the dialog opens). This module is that cache keyed for the composer, and it
 * reuses `createSearchCache` rather than growing a second one — which also
 * means `invalidateGlobalSearchCaches()` clears these too, so the two surfaces
 * can never show a differently-stale view of the same store.
 *
 * Keyed by context, not global: `@chat:` excludes the conversation you are
 * composing in and every source is workspace-scoped, so one cached list per
 * `(kind, projectId, sessionId)`. A plain single-slot cache — which is what
 * `createListProvider` uses for its host-level lists — would hand the previous
 * conversation's candidate list to the next one.
 */

import { createSearchCache, type SearchCache } from "@/lib/global-search/cache"
import type {
  EntityMentionCandidate,
  EntityMentionContext,
  EntityMentionSource,
} from "./entity-sources"

/**
 * Context keys kept before the oldest is dropped.
 *
 * One entry per conversation the user has typed `@` in, per source. Small and
 * bounded: without a cap this grows for the lifetime of the tab, and each entry
 * pins a whole candidate list (for `@chat:`, every session's title). Eight is
 * comfortably more than the set of conversations in play at one time while
 * keeping the retained set trivial.
 */
export const ENTITY_CACHE_MAX_KEYS = 8

interface Entry {
  key: string
  cache: SearchCache<EntityMentionCandidate[]>
}

/** Insertion-ordered; the first entry is the least recently created. */
const entries = new Map<string, Entry>()

/**
 * `kind \0 projectId \0 sessionId`.
 *
 * NUL-separated, the same choice `lib/chat/search/corpus.ts` makes for its
 * haystack and for the same reason: a session id is opaque, and any separator
 * that can occur inside one lets two different contexts collide on a single key
 * — which here means serving one conversation the other's candidate list.
 */
function cacheKey(source: EntityMentionSource, ctx: EntityMentionContext): string {
  return `${source.entityKind}\u0000${ctx.projectId ?? ""}\u0000${ctx.sessionId ?? ""}`
}

/**
 * The source's full candidate list for this context, cached.
 *
 * Throws through: a failed read must reach the panel's error branch rather than
 * resolving to an empty list that reads as "no matches".
 */
export function loadEntityCandidates(
  source: EntityMentionSource,
  ctx: EntityMentionContext
): Promise<EntityMentionCandidate[]> {
  if (!source.load) {
    throw new Error(`entity mention source "${source.entityKind}" has no load()`)
  }
  const load = source.load.bind(source)
  const key = cacheKey(source, ctx)
  let entry = entries.get(key)
  if (!entry) {
    entry = { key, cache: createSearchCache(() => load(ctx)) }
    entries.set(key, entry)
    // Oldest-first eviction. `Map` iterates in insertion order, and an existing
    // key is never re-inserted above, so the first key is the oldest.
    while (entries.size > ENTITY_CACHE_MAX_KEYS) {
      const oldest = entries.keys().next()
      if (oldest.done) break
      entries.get(oldest.value)?.cache.clear()
      entries.delete(oldest.value)
    }
  }
  return entry.cache.get()
}

/**
 * Drop every cached candidate list.
 *
 * Called when the `@` panel opens, for the same reason ⌘K drops its caches when
 * the dialog opens: within one picking session a 15 s window is invisible, but
 * a user who just created the record they are about to reference must not have
 * to wait for a TTL to see it.
 */
export function invalidateEntityMentionCaches(): void {
  for (const entry of entries.values()) entry.cache.clear()
  entries.clear()
}

/** Test-only: the live key set, for asserting eviction. */
export function __entityMentionCacheKeysForTests(): string[] {
  return [...entries.keys()]
}
