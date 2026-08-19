/**
 * Resident search corpus — the whole of Phase A's "index".
 *
 * The chain of reasoning that lands here:
 *
 *  1. Result rows must highlight the match, so the search must produce character
 *     offsets. Only comparing against the real text yields those.
 *  2. So the text has to be reachable on the query path regardless.
 *  3. Once the text is reachable, `String.prototype.indexOf` over a few large
 *     concatenated strings is the fastest thing available — V8 searches at
 *     roughly 1-5 GB/s, so tens of MB scan in tens of milliseconds, well inside
 *     a debounced keystroke and faster than an IndexedDB index probe.
 *  4. Therefore an inverted index would add consistency machinery, a backfill of
 *     derived data, and 2-3x storage to make step 3 slower.
 *
 * A fixed-width fingerprint (hash each n-gram into m buckets, store the set
 * buckets) was designed and rejected on arithmetic: entries per message are
 * min(grams, m) while selectivity needs m >> grams. At m = 64 a 200-gram message
 * lights 64·(1-(63/64)^200) ≈ 61 buckets, so a two-gram query admits ≈ (61/64)²
 * ≈ 91% of all messages as candidates — a full scan wearing an index's clothes.
 * Raising m restores selectivity and puts the entry count straight back to
 * ~grams-per-message.
 *
 * Rows are held newest-first because that is the order results are wanted in and
 * because it makes `limit` a genuine early exit: a query with enough recent hits
 * never touches older text. History evicted past {@link RESIDENT_MESSAGE_CAP} is
 * reached through `scanOlderChatSearchText`, bounded by `oldestResidentAt`.
 *
 * Phase B, if measurement demands it, adds a `*grams` column to the same table as
 * a session-level prefilter. Nothing here has to change for that.
 */

import type { ChatSearchTextRow } from "@/lib/db/chat-search-text"
import { findOccurrences } from "@/lib/chat/message-search"

/**
 * Messages kept in memory.
 *
 * CJK text is two bytes per character in V8, so this cap is the memory knob:
 * 30k messages averaging ~400 chars is ~12M chars ≈ 24MB, doubling for two-byte
 * strings. Desktop can afford it; mobile only ever syncs a few hundred messages,
 * so it never approaches the cap.
 */
export const RESIDENT_MESSAGE_CAP = 30_000

/** Target size of one concatenated haystack chunk. */
export const CHUNK_TARGET_CHARS = 4_000_000

/**
 * Row separator inside a chunk.
 *
 * NUL, written as an escape so this file stays ASCII — a literal control byte
 * makes ripgrep treat the whole module as binary and silently drop it from
 * every future search.
 *
 * It is stripped from both projected text and queries, so a match can never
 * straddle two messages and be attributed to one that never contained it. A
 * printable separator (a space, say) would let `"alpha bravo"` find the join of
 * two adjacent messages; the per-row re-verification below would reject it, but
 * only after paying for the candidate.
 */
const SEPARATOR = "\u0000"

export interface CorpusHit {
  row: ChatSearchTextRow
  /** Offset of the first match **within `row.text`**. */
  at: number
  /** Occurrences inside this row. */
  count: number
}

export interface BuildCorpusOptions {
  residentCap?: number
  chunkTargetChars?: number
}

/** Ratio of tombstoned rows that triggers a chunk rebuild. */
const COMPACT_THRESHOLD = 0.5

interface Chunk {
  /** Lower-cased `text` of each member, NUL-separated. */
  haystack: string
  /** `starts[i]` is where member `i`'s text begins in `haystack`. */
  starts: number[]
  rows: ChatSearchTextRow[]
}

/**
 * Strip characters that would break the separator invariant. Length-preserving,
 * so offsets computed on the sanitized body still address `row.text`.
 */
function sanitize(text: string): string {
  return text.includes(SEPARATOR) ? text.replaceAll(SEPARATOR, " ") : text
}

function buildChunk(rows: readonly ChatSearchTextRow[]): Chunk {
  const parts: string[] = []
  const starts: number[] = []
  let at = 0
  for (const row of rows) {
    const body = sanitize(row.text).toLowerCase()
    starts.push(at)
    parts.push(body)
    at += body.length + SEPARATOR.length
  }
  return { haystack: parts.join(SEPARATOR), starts, rows: [...rows] }
}

/** Index of the member owning `offset`. `starts` is ascending. */
function memberAt(starts: number[], offset: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * Newest-first ordering. `messageId` breaks a tie so two rows minted in the
 * same millisecond order deterministically rather than by insertion accident.
 */
function compareNewestFirst(a: ChatSearchTextRow, b: ChatSearchTextRow): number {
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt
  return a.messageId < b.messageId ? 1 : a.messageId > b.messageId ? -1 : 0
}

/** Merge two newest-first lists into one, in O(n). */
function mergeNewestFirst(
  a: readonly ChatSearchTextRow[],
  b: readonly ChatSearchTextRow[]
): ChatSearchTextRow[] {
  const out: ChatSearchTextRow[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    out.push(compareNewestFirst(a[i], b[j]) <= 0 ? a[i++] : b[j++])
  }
  while (i < a.length) out.push(a[i++])
  while (j < b.length) out.push(b[j++])
  return out
}

class ResidentCorpus {
  private chunks: Chunk[] = []
  private tombstones = new Set<string>()
  private readonly residentCap: number
  private readonly chunkTargetChars: number

  constructor(rows: readonly ChatSearchTextRow[], options: BuildCorpusOptions = {}) {
    this.residentCap = options.residentCap ?? RESIDENT_MESSAGE_CAP
    this.chunkTargetChars = options.chunkTargetChars ?? CHUNK_TARGET_CHARS
    this.reset(rows.slice(0, this.residentCap))
  }

  private reset(rows: readonly ChatSearchTextRow[]): void {
    this.chunks = []
    this.tombstones.clear()
    let batch: ChatSearchTextRow[] = []
    let chars = 0
    for (const row of rows) {
      batch.push(row)
      chars += row.text.length
      if (chars >= this.chunkTargetChars) {
        this.chunks.push(buildChunk(batch))
        batch = []
        chars = 0
      }
    }
    if (batch.length > 0) this.chunks.push(buildChunk(batch))
  }

  /** Live rows, newest-first. */
  private liveRows(): ChatSearchTextRow[] {
    const out: ChatSearchTextRow[] = []
    for (const chunk of this.chunks) {
      for (const row of chunk.rows) {
        if (!this.tombstones.has(row.messageId)) out.push(row)
      }
    }
    return out
  }

  get size(): number {
    let n = 0
    for (const chunk of this.chunks) n += chunk.rows.length
    return n - this.tombstones.size
  }

  /** Characters of live text. Excludes bodies awaiting compaction. */
  get chars(): number {
    let n = 0
    for (const chunk of this.chunks) {
      for (const row of chunk.rows) {
        if (!this.tombstones.has(row.messageId)) n += row.text.length
      }
    }
    return n
  }

  /**
   * Characters actually scanned per query, tombstoned bodies included.
   *
   * Distinct from `chars` on purpose: this is what compaction reduces, and the
   * only way a test can prove compaction happened rather than assuming it.
   */
  get haystackChars(): number {
    let n = 0
    for (const chunk of this.chunks) n += chunk.haystack.length
    return n
  }

  /**
   * `createdAt` of the oldest resident row, or `null` when nothing is resident.
   * Callers pass this to `scanOlderChatSearchText` as the cutoff, so the two
   * halves of the query cover the corpus exactly once.
   */
  get oldestResidentAt(): number | null {
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const rows = this.chunks[i].rows
      for (let j = rows.length - 1; j >= 0; j--) {
        if (!this.tombstones.has(rows[j].messageId)) return rows[j].createdAt
      }
    }
    return null
  }

  /**
   * Rows whose text contains `needle`, newest-first, at most `limit` of them.
   *
   * One hit per row with an occurrence count, not one per occurrence: the caller
   * ranks and renders messages, and a common word would otherwise produce a
   * result list proportional to the corpus rather than to the answer.
   */
  search(needle: string, limit: number): CorpusHit[] {
    if (limit <= 0) return []
    const trimmed = needle.trim().replaceAll(SEPARATOR, "").toLowerCase()
    if (!trimmed) return []

    const hits: CorpusHit[] = []
    for (const chunk of this.chunks) {
      let from = 0
      for (;;) {
        const found = chunk.haystack.indexOf(trimmed, from)
        if (found === -1) break
        const member = memberAt(chunk.starts, found)
        const row = chunk.rows[member]
        // Skip past this member either way: its occurrences are counted in one
        // pass below, so re-entering it would double-count.
        from = chunk.starts[member] + row.text.length + SEPARATOR.length
        if (this.tombstones.has(row.messageId)) continue
        const occurrences = findOccurrences(sanitize(row.text).toLowerCase(), trimmed)
        // Zero is reachable: the raw hit may have straddled the separator.
        if (occurrences.length === 0) continue
        hits.push({ row, at: occurrences[0], count: occurrences.length })
        if (hits.length >= limit) return hits
      }
    }
    return hits
  }

  /**
   * Fold projections into the corpus, keeping it newest-first.
   *
   * Re-adding a `messageId` replaces it rather than duplicating, mirroring the
   * idempotent Dexie write — a message re-projected by a second WebView must not
   * appear twice in the result list.
   *
   * The incoming rows are **merged by `createdAt`**, not prepended. They used to
   * be prepended on the assumption that anything freshly indexed is newer than
   * everything resident, which holds for a streaming turn and fails for every
   * other producer: an external-agent history import (ADR-0062) writes years-old
   * transcripts, and a connector backfill writes whatever the platform hands it.
   * A prepended old row breaks the ordering invariant `oldestResidentAt` reads,
   * so the cursor handed to `scanOlderChatSearchText` would name a *recent*
   * instant and silently hide every older message from the query.
   */
  fold(rows: readonly ChatSearchTextRow[]): void {
    if (rows.length === 0) return
    const incoming = [...rows].sort(compareNewestFirst)
    const replaced = new Set(incoming.map((r) => r.messageId))
    const kept = this.liveRows().filter((r) => !replaced.has(r.messageId))
    this.reset(mergeNewestFirst(incoming, kept).slice(0, this.residentCap))
  }

  /** Forget messages that were deleted or truncated away. */
  remove(ids: readonly string[]): void {
    if (ids.length === 0) return
    let changed = false
    for (const id of ids) {
      if (this.tombstones.has(id)) continue
      this.tombstones.add(id)
      changed = true
    }
    if (!changed) return
    const total = this.chunks.reduce((n, chunk) => n + chunk.rows.length, 0)
    // Rebuild once the dead outweigh the living, so removed text stops being
    // scanned on every query.
    if (total > 0 && this.tombstones.size / total >= COMPACT_THRESHOLD) {
      this.reset(this.liveRows())
    }
  }
}

export type Corpus = ResidentCorpus

/**
 * Build a corpus from rows in **newest-first** order — the order
 * `loadNewestChatSearchText` returns.
 */
export function buildCorpus(
  rows: readonly ChatSearchTextRow[],
  options: BuildCorpusOptions = {}
): Corpus {
  return new ResidentCorpus(rows, options)
}
