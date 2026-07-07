"use client"

/**
 * In-app find. Walks the visible content region (`[data-find-scope]` → `main` →
 * `body`) for case-insensitive matches of the query, exposes a match count +
 * 1-based active index, and cycles through matches. When the browser supports
 * the CSS Custom Highlight API (Chromium WebView2, recent WebKit) matches are
 * painted via `::highlight(cognia-find)` / `::highlight(cognia-find-active)`;
 * the active match is always scrolled into view so navigation works even where
 * the highlight API is unavailable.
 */

import { useCallback, useEffect, useMemo, useState } from "react"

const HIGHLIGHT_ALL = "cognia-find"
const HIGHLIGHT_ACTIVE = "cognia-find-active"
const HIGHLIGHT_STYLE_ID = "cognia-find-highlight-styles"

interface HighlightLike {
  readonly _brand?: "highlight"
}
interface HighlightRegistry {
  set(name: string, highlight: HighlightLike): void
  delete(name: string): void
}
type HighlightCtor = new (...ranges: Range[]) => HighlightLike

/** Feature-detect the CSS Custom Highlight API without leaning on lib.dom. */
function highlightApi(): { registry: HighlightRegistry; Ctor: HighlightCtor } | null {
  const g = globalThis as unknown as {
    CSS?: { highlights?: HighlightRegistry }
    Highlight?: HighlightCtor
  }
  if (g.CSS?.highlights && typeof g.Highlight === "function") {
    return { registry: g.CSS.highlights, Ctor: g.Highlight }
  }
  return null
}

/**
 * Inject the `::highlight()` styling for find matches once, at runtime. These
 * rules live here rather than in `globals.css` because the build-time CSS parser
 * (Turbopack/Next.js) rejects the `::highlight()` pseudo-element and drops the
 * rule; the browser's own parser — which only ever sees this injected `<style>`
 * — accepts it. `var(--primary)` / `color-mix(...)` resolve against `:root`.
 * Only called once the Custom Highlight API is confirmed present, so it never
 * runs where the styling would be inert. Idempotent via a stable element id.
 */
function ensureHighlightStyles(): void {
  if (document.getElementById(HIGHLIGHT_STYLE_ID)) return
  const style = document.createElement("style")
  style.id = HIGHLIGHT_STYLE_ID
  style.textContent = `
::highlight(${HIGHLIGHT_ALL}) {
  background-color: color-mix(in oklch, var(--primary) 25%, transparent);
  color: inherit;
}
::highlight(${HIGHLIGHT_ACTIVE}) {
  background-color: var(--primary);
  color: var(--primary-foreground);
}`
  document.head.appendChild(style)
}

function findScopeRoot(): HTMLElement | null {
  if (typeof document === "undefined") return null
  return (
    document.querySelector<HTMLElement>("[data-find-scope]") ??
    document.querySelector<HTMLElement>("main") ??
    document.body
  )
}

/**
 * Collect one `Range` per case-insensitive occurrence of `query` inside `root`,
 * skipping script/style and any subtree marked `[data-find-ignore]` (the find
 * bar's own chrome). Exported for direct unit testing.
 */
export function collectMatchRanges(root: HTMLElement | null, query: string): Range[] {
  if (!root || query.length === 0) return []
  const needle = query.toLowerCase()
  const ranges: Range[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      if (parent.closest("[data-find-ignore]")) return NodeFilter.FILTER_REJECT
      const tag = parent.tagName
      if (tag === "SCRIPT" || tag === "STYLE") return NodeFilter.FILTER_REJECT
      const text = node.textContent
      return text && text.trim().length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    },
  })
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const hay = (node.textContent ?? "").toLowerCase()
    let from = hay.indexOf(needle)
    while (from !== -1) {
      const range = document.createRange()
      range.setStart(node, from)
      range.setEnd(node, from + needle.length)
      ranges.push(range)
      from = hay.indexOf(needle, from + needle.length)
    }
  }
  return ranges
}

export interface UseFindInPageResult {
  query: string
  setQuery: (q: string) => void
  matchCount: number
  /** 1-based index of the active match, or 0 when there are none. */
  activeIndex: number
  next: () => void
  prev: () => void
}

export function useFindInPage(active: boolean): UseFindInPageResult {
  const [query, setQuery] = useState("")
  const [ranges, setRanges] = useState<Range[]>([])
  const [activeIndex, setActiveIndex] = useState(0)

  const matchCount = ranges.length

  // Recompute matches when the query changes (only while the bar is open).
  // Ranges derive from the live DOM, so they must be read in an effect.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRanges(!active || query.length === 0 ? [] : collectMatchRanges(findScopeRoot(), query))
  }, [active, query])

  // Reset the active pointer to the first match on every new result set.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveIndex(ranges.length > 0 ? 1 : 0)
  }, [ranges])

  // Paint highlights (when supported) and scroll the active match into view.
  useEffect(() => {
    const api = highlightApi()
    if (api) {
      ensureHighlightStyles()
      api.registry.delete(HIGHLIGHT_ALL)
      api.registry.delete(HIGHLIGHT_ACTIVE)
      if (ranges.length > 0) {
        api.registry.set(HIGHLIGHT_ALL, new api.Ctor(...ranges))
      }
    }
    const activeRange = ranges[activeIndex - 1]
    if (api && activeRange) {
      api.registry.set(HIGHLIGHT_ACTIVE, new api.Ctor(activeRange))
    }
    if (activeRange) {
      const el = activeRange.startContainer.parentElement
      try {
        el?.scrollIntoView?.({ block: "center" })
      } catch {
        // scrollIntoView is a no-op in some environments — ignore.
      }
    }
  }, [ranges, activeIndex])

  // Clear highlights when the hook unmounts. (Closing the bar sets `active`
  // false, which empties `ranges` above and the paint effect clears them.)
  useEffect(() => {
    return () => {
      const api = highlightApi()
      if (api) {
        api.registry.delete(HIGHLIGHT_ALL)
        api.registry.delete(HIGHLIGHT_ACTIVE)
      }
    }
  }, [])

  const next = useCallback(() => {
    setActiveIndex((i) => (matchCount === 0 ? 0 : (i % matchCount) + 1))
  }, [matchCount])

  const prev = useCallback(() => {
    setActiveIndex((i) => (matchCount === 0 ? 0 : ((i - 2 + matchCount) % matchCount) + 1))
  }, [matchCount])

  return useMemo(
    () => ({ query, setQuery, matchCount, activeIndex, next, prev }),
    [query, matchCount, activeIndex, next, prev]
  )
}
