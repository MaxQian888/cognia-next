/**
 * Search engines the selection toolbar's "Search" action can hand off to.
 *
 * The renderer only ever names an engine; the URL template lives in Rust,
 * which builds and encodes the query itself. That split is deliberate — the
 * renderer's payload is a UX hint, not authority, and a template assembled on
 * this side would be one more untrusted string reaching the OS opener.
 */

export const SELECTION_SEARCH_ENGINE_PREF = "selectionToolbar.searchEngine"

export const SEARCH_ENGINES = ["google", "bing", "duckduckgo", "baidu"] as const
export type SearchEngineId = (typeof SEARCH_ENGINES)[number]

export function isSearchEngineId(value: unknown): value is SearchEngineId {
  return typeof value === "string" && (SEARCH_ENGINES as readonly string[]).includes(value)
}

/**
 * A sensible starting engine for the user's UI language.
 *
 * Only Chinese gets a non-default, because it is the one case where the
 * default is likely to be unreachable rather than merely unfamiliar.
 */
export function defaultSearchEngine(locale: string): SearchEngineId {
  return locale.toLowerCase().startsWith("zh") ? "baidu" : "google"
}
