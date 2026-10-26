/**
 * Candidate pairs of rules that rule on the same point from two surfaces
 * (ADR-0238 §7.4).
 *
 * Two files can rule on one thing without ever being read side by side. This
 * finds the pairs worth asking about — rules from different surfaces that
 * share enough content words — so the conflict judgment sees a short list,
 * never every pair. It decides nothing: agreeing copies are working
 * redundancy (keep-list item 8) and a narrower file's scoped rule is an
 * override, both left alone by the judgment.
 */

import type { RuleUnit } from "./segment"

export interface SurfaceUnits {
  surfaceKey: string
  units: readonly RuleUnit[]
}

export interface OverlapCandidate {
  a: { surfaceKey: string; unit: RuleUnit }
  b: { surfaceKey: string; unit: RuleUnit }
  similarity: number
  shared: string[]
}

/** Below this Jaccard similarity two rules are about different things. */
export const OVERLAP_MIN_SIMILARITY = 0.3
/** Two rules must share at least this many content words. */
export const OVERLAP_MIN_SHARED = 3
/** The judgment sees at most this many pairs, most similar first. */
export const OVERLAP_MAX_PAIRS = 40

const STOP_WORDS = new Set(
  (
    "a an and are as at be before by can do does for from has have if in into is it its may " +
    "must never no not of on or should so than that the then there these this those to use " +
    "using was we when where which while will with you your always only also all any each " +
    "every after don't dont"
  ).split(" ")
)

/** Lower-case content words, light stemming, stop words dropped. */
export function contentWords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/`[^`]*`/g, (span) => ` ${span.slice(1, -1)} `)
    .split(/[^a-z0-9_.:/-]+|[　-鿿]/)
    .map((word) => word.replace(/^[.:/-]+|[.:/-]+$/g, ""))
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word))
    .map((word) => word.replace(/(?:ing|ed|es|s)$/, ""))
  const out = new Set(words)
  // CJK text has no spaces: use character bigrams so Chinese rules overlap too.
  const cjk = text.match(/[一-鿿]+/g) ?? []
  for (const run of cjk) {
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2))
  }
  return out
}

export function findOverlaps(surfaces: readonly SurfaceUnits[]): OverlapCandidate[] {
  const entries = surfaces.flatMap((surface) =>
    surface.units.map((unit) => ({
      surfaceKey: surface.surfaceKey,
      unit,
      words: contentWords(unit.text),
    }))
  )
  const candidates: OverlapCandidate[] = []
  for (let i = 0; i < entries.length; i++) {
    const left = entries[i]!
    if (left.words.size < OVERLAP_MIN_SHARED) continue
    for (let j = i + 1; j < entries.length; j++) {
      const right = entries[j]!
      if (right.surfaceKey === left.surfaceKey || right.words.size < OVERLAP_MIN_SHARED) continue
      const shared = [...left.words].filter((word) => right.words.has(word))
      if (shared.length < OVERLAP_MIN_SHARED) continue
      const similarity = shared.length / (left.words.size + right.words.size - shared.length)
      if (similarity < OVERLAP_MIN_SIMILARITY) continue
      candidates.push({
        a: { surfaceKey: left.surfaceKey, unit: left.unit },
        b: { surfaceKey: right.surfaceKey, unit: right.unit },
        similarity,
        shared: shared.slice(0, 8),
      })
    }
  }
  return candidates.sort((x, y) => y.similarity - x.similarity).slice(0, OVERLAP_MAX_PAIRS)
}
