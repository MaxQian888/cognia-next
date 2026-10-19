/**
 * Word boundaries for the site's Chinese headlines, decided once at build time.
 *
 * `SplitReveal` sets a CJK headline one character per inline-block mask, and a
 * line may break after any inline-block: a word joiner between two masks does
 * not hold them together. Keeping a word on one line takes a `nowrap` wrapper
 * around its characters, and that wrapper is markup, so the server and the
 * browser must agree on it exactly or hydration fails. `Intl.Segmenter` cannot
 * be asked at render time — the server's ICU and the browser's segment
 * differently — so `scripts/build-cjk-words.mjs` asks Node's once and writes
 * `content/generated/cjk-words.json`, which both sides then read.
 *
 * Pure and dependency-free on purpose: the build script imports this file
 * directly with Node's type stripping, outside the `@web/*` alias.
 */

/** Han, kana and Hangul: scripts that set without spaces and may break between any two characters. */
export const CJK = /[⺀-⿿぀-ヿ㄀-ㇿ㐀-䶿一-鿿가-힯豈-﫿]/u

/** A headline as `SplitReveal` sets it: trimmed, with each run of whitespace one space. */
export function normalizeTitle(text: string): string {
  return text.trim().replace(/\s+/gu, " ")
}

/**
 * Every CJK string held under a `title` key, anywhere in the copy. Every
 * `SplitReveal` headline on the site is a copy `title`, so this is the set the
 * map must cover; a title it misses falls back to per-character breaks.
 */
export function collectCjkTitles(copy: unknown): string[] {
  const titles = new Set<string>()
  const walk = (value: unknown, key: string) => {
    if (typeof value === "string") {
      if (key === "title" && CJK.test(value)) titles.add(normalizeTitle(value))
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, key)
      return
    }
    if (value && typeof value === "object") {
      for (const [childKey, child] of Object.entries(value)) walk(child, childKey)
    }
  }
  walk(copy, "")
  return [...titles].sort()
}

/** The longest run that single characters are merged into. */
const MAX_MERGED_RUN = 4

/**
 * UTF-16 offsets where a word starts in `text`, after the first.
 *
 * ICU falls back to one segment per character for a word its dictionary
 * lacks (四|个|模|块), which would let 模块 break apart. Adjacent
 * single-character CJK segments are therefore merged into one run of at most
 * four characters; a multi-character word, punctuation or Latin text always
 * ends the run.
 */
export function wordStarts(text: string, segmenter: Intl.Segmenter): number[] {
  const starts: number[] = []
  let run = 0
  let previousSingle = false
  for (const { segment, index } of segmenter.segment(text)) {
    const single = [...segment].length === 1 && CJK.test(segment)
    if (single && previousSingle && run < MAX_MERGED_RUN) {
      run++
      continue
    }
    if (index > 0) starts.push(index)
    run = 1
    previousSingle = single
  }
  return starts
}

/** The generated map: each CJK title of the copy, with its word starts. */
export function buildCjkWords(copy: unknown, segmenter: Intl.Segmenter): Record<string, number[]> {
  const map: Record<string, number[]> = {}
  for (const title of collectCjkTitles(copy)) map[title] = wordStarts(title, segmenter)
  return map
}
