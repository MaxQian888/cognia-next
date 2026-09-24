/**
 * Cached Shiki highlighting for finalized chat code blocks.
 *
 * The chat list is virtualized: rows outside the overscan window unmount and
 * remount as the user scrolls. Without a cache, every remount re-ran two
 * `codeToHtml` passes (light + dark), producing a visible flash of unstyled
 * `<pre>` → highlighted swap on every scroll-in plus redundant CPU. This module
 * memoizes the rendered HTML so a remount of already-seen code is synchronous
 * and flash-free. It mirrors the bespoke KaTeX cache in `lib/latex/cache.ts`.
 *
 * The theme pair comes from `CHAT_CODE_THEME` (the single source of truth shared
 * with streaming via Streamdown), so it is baked into the cache key for safety
 * — if the theme ever changes, old entries simply miss instead of returning
 * stale colors.
 */
import {
  bundledLanguages,
  codeToHtml,
  getSingletonHighlighter,
  type BundledLanguage,
  type LanguageRegistration,
} from "shiki"
import { LruCache } from "@cognia/primitives"
import { CHAT_CODE_THEME } from "@/lib/chat/code-theme"
import { createMutex } from "@cognia/primitives"
import { findGrammarsByLanguage } from "@/lib/plugin/bridge/grammars-bridge"

export interface HighlightHtml {
  light: string
  dark: string
}

// Bounded to keep memory in check across very long sessions; deterministic by
// key, so eviction only ever costs a re-highlight, never correctness.
const cache = new LruCache<HighlightHtml>(300, {
  // Approximate UTF-16 string payload, not a measurement of total JS heap.
  maxWeight: 16 * 1024 * 1024,
  weigh: ({ light, dark }, key) => 2 * (key.length + light.length + dark.length),
})
let cacheGeneration = 0

// De-dupe concurrent highlight requests for identical (code, language): two
// rows with the same snippet, or a remount racing the first paint, share one
// `codeToHtml` pass instead of two.
const inflight = new Map<string, Promise<HighlightHtml>>()

/**
 * Highlights run one at a time.
 *
 * `codeToHtml` is CPU-bound tokenisation, so N concurrent passes do not finish
 * sooner than N sequential ones — they interleave into one long unbroken
 * main-thread block instead of N shorter ones the browser can schedule around.
 * Scrolling a code-heavy transcript mounts a screenful of distinct fences at
 * once, and each of them is TWO passes (light + dark). Serializing turns that
 * into a queue that yields between items.
 *
 * Cache hits and in-flight duplicates never reach the gate, so the common case
 * is unaffected. `packages/mermaid/src/render-cache.ts` proved the shape.
 */
const highlightGate = createMutex()

/**
 * Exact source identity is required: matching ends can hide different code in
 * the middle. Length-prefix the language so even embedded separators remain
 * unambiguous. The full source key counts toward the retained payload budget.
 */
function cacheKey(code: string, language: string): string {
  return `${CHAT_CODE_THEME.light}\0${CHAT_CODE_THEME.dark}\0${language.length}:${language}${code}`
}

/**
 * Synchronous cache lookup. Returns the rendered HTML if this exact snippet was
 * highlighted before, else `undefined`. Used to seed component state on mount
 * so a re-scrolled row paints highlighted immediately (no flash).
 */
export function getCachedHighlight(code: string, language: string): HighlightHtml | undefined {
  return cache.get(cacheKey(code, language))
}

/**
 * Highlight `code` to light + dark HTML, returning a cached result when
 * available. Concurrent calls for the same key share one in-flight pass.
 */
export async function highlightCached(code: string, language: string): Promise<HighlightHtml> {
  const key = cacheKey(code, language)
  const hit = cache.get(key)
  if (hit) return hit

  const pending = inflight.get(key)
  if (pending) return pending

  const generation = cacheGeneration
  const task = (async (): Promise<HighlightHtml> => {
    try {
      return await highlightGate.runExclusive(async () => {
        // Re-check inside the gate: while this call waited its turn, an
        // earlier queued pass for the same key may have finished and filled
        // the cache. Mirrors the mermaid render cache's re-check.
        const queued = generation === cacheGeneration ? cache.get(key) : undefined
        if (queued) return queued

        // W5.1: a plugin-contributed TextMate grammar for a non-bundled
        // language is loaded into shiki's singleton once, then the normal
        // shorthand path highlights with it.
        await ensurePluginGrammarLoaded(language)
        // Sequential, not `Promise.all`: the two themes contend for the same
        // thread anyway, and running them back to back leaves a yield point
        // between them.
        const light = await codeToHtml(code, {
          lang: language as BundledLanguage,
          theme: CHAT_CODE_THEME.light,
        })
        const dark = await codeToHtml(code, {
          lang: language as BundledLanguage,
          theme: CHAT_CODE_THEME.dark,
        })
        const result: HighlightHtml = { light, dark }
        // Clearing invalidates active and queued writes, without interrupting
        // the callers already awaiting their own highlight result.
        if (generation === cacheGeneration) cache.set(key, result)
        return result
      })
    } finally {
      if (generation === cacheGeneration) inflight.delete(key)
    }
  })()

  inflight.set(key, task)
  return task
}

// Languages already fed to the shiki singleton from plugin grammars, so a
// re-highlight doesn't re-load the grammar. A failed load records `false` so
// the fallback (plain rendering upstream) doesn't retry every keystroke.
const pluginGrammarLoads = new Map<string, Promise<boolean>>()

/**
 * Load a plugin-contributed TextMate grammar for `language` into shiki's
 * singleton highlighter when the language isn't bundled (W5.1). No-op for
 * bundled languages and languages without a registered plugin grammar.
 */
async function ensurePluginGrammarLoaded(language: string): Promise<boolean> {
  if (language in ((bundledLanguages ?? {}) as Record<string, unknown>)) return true
  const existing = pluginGrammarLoads.get(language)
  if (existing) return existing
  const grammars = findGrammarsByLanguage(language)
  if (grammars.length === 0) return false
  const task = (async () => {
    try {
      const highlighter = await getSingletonHighlighter({
        themes: [CHAT_CODE_THEME.light, CHAT_CODE_THEME.dark],
      })
      // The grammar payload IS a TextMate LanguageRegistration body; stamp
      // the language name so shiki can resolve `lang: language`.
      await highlighter.loadLanguage({
        ...(grammars[0].data as unknown as LanguageRegistration),
        name: language,
        scopeName: grammars[0].scopeName,
      })
      return true
    } catch {
      return false
    }
  })()
  pluginGrammarLoads.set(language, task)
  return task
}

/** Test-only: forget which plugin grammars were loaded. */
export function __resetPluginGrammarLoadsForTesting(): void {
  pluginGrammarLoads.clear()
}

/** Test/diagnostic helper — drop all cached highlights. */
export function clearHighlightCache(): void {
  cacheGeneration += 1
  cache.clear()
  inflight.clear()
}
