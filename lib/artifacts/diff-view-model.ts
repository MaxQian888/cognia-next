/**
 * View-model helpers for the lightweight line diff (`LineDiffView`): the
 * side-by-side pairing, the word-level emphasis between a removed line and the
 * added line that replaced it, and in-view find. Pure, so the component stays
 * a renderer and each rule has one test.
 */

import type { DiffLine } from "@/types"
import { computeIntralineDiff, type IntralineSegment } from "@/lib/chat/intraline-diff"
import type { DiffRow } from "./diff"

/** One line of the source diff with its index into it. */
export interface DiffEntry {
  line: DiffLine
  index: number
}

/** A rendered row of the side-by-side layout. */
export type SplitRow =
  | { kind: "pair"; left: DiffEntry | null; right: DiffEntry | null }
  | Exclude<DiffRow, { kind: "line" }>

/**
 * Pair rows for a side-by-side view: an unchanged line sits on both sides; a
 * run of removals followed by a run of additions is zipped line by line, the
 * longer run continuing against blanks; gaps and headers span both sides.
 */
export function toSplitRows(rows: readonly DiffRow[]): SplitRow[] {
  const out: SplitRow[] = []
  let i = 0
  while (i < rows.length) {
    const row = rows[i]
    if (row.kind !== "line") {
      out.push(row)
      i++
      continue
    }
    if (row.line.type === "unchanged") {
      const entry = { line: row.line, index: row.index }
      out.push({ kind: "pair", left: entry, right: entry })
      i++
      continue
    }
    const removed: DiffEntry[] = []
    const added: DiffEntry[] = []
    while (i < rows.length) {
      const r = rows[i]
      if (r.kind !== "line" || r.line.type !== "removed") break
      removed.push({ line: r.line, index: r.index })
      i++
    }
    while (i < rows.length) {
      const r = rows[i]
      if (r.kind !== "line" || r.line.type !== "added") break
      added.push({ line: r.line, index: r.index })
      i++
    }
    for (let k = 0; k < Math.max(removed.length, added.length); k++) {
      out.push({ kind: "pair", left: removed[k] ?? null, right: added[k] ?? null })
    }
  }
  return out
}

/**
 * Removed line ↔ the added line that replaced it, by source index, both ways.
 * Within one change block the k-th removal pairs with the k-th addition — the
 * same pairing the side-by-side view draws.
 */
export function pairChangedLines(source: readonly DiffEntry[]): Map<number, DiffLine> {
  const partners = new Map<number, DiffLine>()
  let i = 0
  while (i < source.length) {
    if (source[i].line.type !== "removed") {
      i++
      continue
    }
    const start = i
    while (i < source.length && source[i].line.type === "removed") i++
    const addStart = i
    while (i < source.length && source[i].line.type === "added") i++
    const pairs = Math.min(addStart - start, i - addStart)
    for (let k = 0; k < pairs; k++) {
      const removed = source[start + k]
      const added = source[addStart + k]
      partners.set(removed.index, added.line)
      partners.set(added.index, removed.line)
    }
  }
  return partners
}

/**
 * Below this share of unchanged characters two paired lines are a rewrite,
 * not an edit: emphasising "what changed" would paint nearly all of both, so
 * they keep the whole-line tint alone.
 */
export const INTRALINE_MIN_SIMILARITY = 0.4

/** Character ranges to emphasise on `line` against its partner, or null. */
export function intralineRanges(
  line: DiffLine,
  partner: DiffLine | undefined
): Array<[number, number]> | null {
  if (!partner || line.type === "unchanged") return null
  const removed = line.type === "removed"
  const diff = removed
    ? computeIntralineDiff(line.content, partner.content)
    : computeIntralineDiff(partner.content, line.content)
  if (!diff) return null
  const segments: IntralineSegment[] = removed ? diff.removed : diff.added
  let equal = 0
  for (const seg of segments) if (seg.kind === "equal") equal += seg.value.length
  const shorter = Math.min(line.content.length, partner.content.length)
  if (shorter === 0 || equal < shorter * INTRALINE_MIN_SIMILARITY) return null
  const ranges: Array<[number, number]> = []
  let at = 0
  for (const seg of segments) {
    if (seg.kind !== "equal") ranges.push([at, at + seg.value.length])
    at += seg.value.length
  }
  return ranges.length > 0 ? ranges : null
}

/** One find hit: a source line and the character offset in it. */
export interface FindMatch {
  index: number
  start: number
}

/** Stop counting past this many hits; the count then reads "10000+". */
export const MAX_FIND_MATCHES = 10_000

/**
 * Case-insensitive, non-overlapping hits of `query` across `lowered` (each
 * source line's content, lower-cased once by the caller), in order.
 */
export function findMatches(
  source: readonly DiffEntry[],
  lowered: readonly string[],
  query: string
): { matches: FindMatch[]; capped: boolean } {
  const needle = query.toLowerCase()
  const matches: FindMatch[] = []
  if (needle.length === 0) return { matches, capped: false }
  for (let i = 0; i < source.length; i++) {
    const text = lowered[i]
    let from = text.indexOf(needle)
    while (from !== -1) {
      if (matches.length >= MAX_FIND_MATCHES) return { matches, capped: true }
      matches.push({ index: source[i].index, start: from })
      from = text.indexOf(needle, from + needle.length)
    }
  }
  return { matches, capped: false }
}

/** A run of a line's text and how it is painted. */
export interface PaintedRun {
  text: string
  changed: boolean
  match: boolean
  current: boolean
}

/**
 * Split `content` into runs at every emphasis boundary: word-level change
 * ranges and find hits (the current hit marked) can overlap, so each run says
 * which of the two it belongs to.
 */
export function paintRuns(
  content: string,
  changed: ReadonlyArray<readonly [number, number]> | null,
  hits: readonly number[] | undefined,
  hitLength: number,
  currentHit: number | null
): PaintedRun[] {
  const cuts = new Set<number>([0, content.length])
  for (const [a, b] of changed ?? []) {
    cuts.add(a)
    cuts.add(b)
  }
  for (const start of hits ?? []) {
    cuts.add(start)
    cuts.add(Math.min(content.length, start + hitLength))
  }
  const points = [...cuts].filter((p) => p >= 0 && p <= content.length).sort((x, y) => x - y)
  const runs: PaintedRun[] = []
  for (let k = 0; k < points.length - 1; k++) {
    const a = points[k]
    const b = points[k + 1]
    if (a === b) continue
    const inChanged = (changed ?? []).some(([s, e]) => a >= s && a < e)
    const hit = (hits ?? []).find((s) => a >= s && a < s + hitLength)
    const run: PaintedRun = {
      text: content.slice(a, b),
      changed: inChanged,
      match: hit !== undefined,
      current: hit !== undefined && hit === currentHit,
    }
    const last = runs[runs.length - 1]
    if (
      last &&
      last.changed === run.changed &&
      last.match === run.match &&
      last.current === run.current
    ) {
      last.text += run.text
    } else {
      runs.push(run)
    }
  }
  return runs
}
