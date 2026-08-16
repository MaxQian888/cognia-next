/**
 * Chat-history search engine (ADR-0099).
 *
 * One engine, four surfaces (desktop/mobile × sidebar/⌘K). The surfaces differ
 * only in how they project the results: the sidebar collapses them per session,
 * ⌘K lists every message hit grouped under its conversation.
 *
 * Query shape:
 *
 *   resident corpus  →  older-history cursor scan (only if short of `limit`)
 *   + not-yet-indexed messages (streaming / dirty queue)
 *   → session metadata for the hit sessions ONLY
 *   → exposure + archive + workspace filters
 *   → absolute scoring → branch dedupe → slice
 *
 * Session metadata is fetched for the hit sessions rather than listed up front.
 * `listScopedSessions().toArray()` pulls every full session row — including
 * `branchSeed.content`, up to 24k chars each — and doing that per keystroke is
 * the same mistake the old content search made with `messages`.
 *
 * The engine reports coverage instead of pretending completeness: a client whose
 * backfill is mid-flight, or whose history exceeds the resident cap, says so.
 * The old implementation silently returned an arbitrary slice.
 */

import type { ChatSession } from "@cognia/agent-config-types"

import { findOccurrences } from "@/lib/chat/message-search"
import { isSessionExposed } from "@/lib/chat/session-exposure"
import {
  getChatSearchState,
  loadNewestChatSearchText,
  scanOlderChatSearchText,
  type ChatSearchTextRow,
} from "@/lib/db/chat-search-text"
import { getDb } from "@/lib/db/schema"
import { buildCorpus, RESIDENT_MESSAGE_CAP, type Corpus, type CorpusHit } from "./corpus"
import { rankHits, type ScoreOptions } from "./score"
import { buildSnippet, type Snippet } from "./snippet"

/** Default number of results a surface asks for. */
export const DEFAULT_SEARCH_LIMIT = 50

/**
 * Multiple of `limit` fetched before filtering.
 *
 * Exposure, archive and workspace filters all reject candidates *after* the
 * corpus produced them, so asking for exactly `limit` would under-deliver
 * whenever the newest matches happen to be filtered out. Three is enough that a
 * workspace holding a third of the account's history still fills a page.
 */
const OVERFETCH = 3

/** How far up a branch chain to walk when resolving lineage. */
const LINEAGE_MAX_DEPTH = 10

export interface ChatSearchResult {
  messageId: string
  sessionId: string
  sessionTitle: string
  projectId: string
  role: string
  createdAt: number
  /** Occurrences in this message. */
  count: number
  /** Offset of the first occurrence in the message text. */
  at: number
  snippet: Snippet
  score: number
  archived: boolean
  /** Branch copies of this same text folded into this row. */
  otherBranchCount: number
}

export interface ChatSearchOutcome {
  results: ChatSearchResult[]
  /**
   * Older history exists that was never scanned, because `limit` was reached
   * first. Distinct from `indexIncomplete` — this one resolves by asking for
   * more, that one by waiting.
   */
  moreOlderHistory: boolean
  /** The lazy backfill has not reached the oldest message yet. */
  indexIncomplete: boolean
}

export interface ChatSearchQuery {
  query: string
  limit?: number
  /** Restrict to one workspace. Omit to search every workspace. */
  projectId?: string
  /** Include archived conversations. */
  includeArchived?: boolean
  /** Return only the highest-ranked message hit from each conversation. */
  collapseBySession?: boolean
  /** Keep only hits authored by one of these roles (`user`, `assistant`, …). */
  roles?: readonly string[]
  /** Keep only hits created at or after this epoch-ms instant. */
  after?: number
  /** Keep only hits created strictly before this epoch-ms instant. */
  before?: number
}

export interface ChatSearchDeps {
  loadCorpus: () => Promise<Corpus>
  scanOlder: (before: number, visit: (row: ChatSearchTextRow) => boolean) => Promise<void>
  getSessions: (ids: readonly string[]) => Promise<Array<ChatSession | undefined>>
  /** Backfill completeness, for the coverage note. */
  isIndexComplete: () => Promise<boolean>
  /**
   * Projections not yet written to Dexie — the session currently streaming, and
   * anything still sitting in the idle indexer's dirty queue. Supplied by the
   * hook layer from the chat store, so this module stays store-free.
   */
  pendingRows: () => readonly ChatSearchTextRow[]
}

/** Lazily-built resident corpus, shared by every caller in this renderer. */
let residentCorpus: Corpus | null = null
let residentLoad: Promise<Corpus> | null = null

async function defaultLoadCorpus(): Promise<Corpus> {
  if (residentCorpus) return residentCorpus
  if (!residentLoad) {
    residentLoad = loadNewestChatSearchText(RESIDENT_MESSAGE_CAP).then((rows) => {
      residentCorpus = buildCorpus(rows)
      residentLoad = null
      return residentCorpus
    })
  }
  return residentLoad
}

/**
 * The live corpus, or `null` when nothing has loaded it yet.
 *
 * The indexer folds new projections in through this rather than invalidating:
 * re-reading 30k rows after every turn would make the corpus cost more than the
 * search it serves.
 */
export function peekResidentCorpus(): Corpus | null {
  return residentCorpus
}

/** Drop the resident corpus. Call after a bulk history change (import, wipe). */
export function invalidateResidentCorpus(): void {
  residentCorpus = null
  residentLoad = null
}

function defaultDeps(): ChatSearchDeps {
  return {
    loadCorpus: defaultLoadCorpus,
    scanOlder: scanOlderChatSearchText,
    getSessions: (ids) => getDb().sessions.bulkGet(ids as string[]),
    isIndexComplete: async () => (await getChatSearchState()).complete,
    pendingRows: () => [],
  }
}

/**
 * Resolve each session's lineage root, pulling in ancestors the hit set did not
 * include. Bounded by {@link LINEAGE_MAX_DEPTH}: a chain longer than that is
 * either corrupt or a cycle, and neither should hang a keystroke.
 */
async function resolveRoots(
  sessions: Map<string, ChatSession>,
  getSessions: ChatSearchDeps["getSessions"]
): Promise<Map<string, string>> {
  const known = new Map(sessions)
  for (let depth = 0; depth < LINEAGE_MAX_DEPTH; depth++) {
    const missing = new Set<string>()
    for (const session of known.values()) {
      const parent = session.parentSessionId
      if (parent && !known.has(parent)) missing.add(parent)
    }
    if (missing.size === 0) break
    const fetched = await getSessions([...missing])
    let added = false
    for (const row of fetched) {
      if (row && !known.has(row.id)) {
        known.set(row.id, row)
        added = true
      }
    }
    // A parent id pointing at a deleted session cannot be resolved; stop rather
    // than looping on the same gap.
    if (!added) break
  }

  const roots = new Map<string, string>()
  for (const id of sessions.keys()) {
    let current = id
    for (let depth = 0; depth < LINEAGE_MAX_DEPTH; depth++) {
      const parent = known.get(current)?.parentSessionId
      if (!parent || !known.has(parent) || parent === current) break
      current = parent
    }
    roots.set(id, current)
  }
  return roots
}

/**
 * Fold away branch copies of one message.
 *
 * A `direct` branch physically copies the visible thread into the new session as
 * real messages (`lib/chat/branch-session.ts`), so text written before a branch
 * point exists verbatim in the parent AND in every branch taken from it. Left
 * alone, one search would return the same sentence three times.
 *
 * Only folded when the two sessions share a lineage root — otherwise two
 * unrelated conversations that both contain "ok" would collapse into one. When
 * lineage cannot be proven the rows stay separate, which is the safe direction.
 */
function dedupeBranchCopies<T extends { sessionId: string; role: string; text: string }>(
  ranked: readonly T[],
  roots: Map<string, string>
): Array<{ hit: T; otherBranchCount: number }> {
  // Grouped on the FULL text, not the snippet: a snippet is a window around the
  // match, so two genuinely different long messages can share one.
  const keyOf = (hit: T) => `${roots.get(hit.sessionId) ?? hit.sessionId} ${hit.role} ${hit.text}`
  const groups = new Map<string, { winner: string; others: Set<string> }>()

  for (const hit of ranked) {
    const key = keyOf(hit)
    const root = roots.get(hit.sessionId) ?? hit.sessionId
    const group = groups.get(key)
    if (!group) {
      groups.set(key, { winner: hit.sessionId, others: new Set() })
      continue
    }
    if (hit.sessionId === group.winner) continue
    // Prefer the lineage root: the branch copied FROM it, so that is where the
    // sentence was actually written.
    if (hit.sessionId === root && group.winner !== root) {
      group.others.add(group.winner)
      group.others.delete(hit.sessionId)
      group.winner = hit.sessionId
      continue
    }
    group.others.add(hit.sessionId)
  }

  const out: Array<{ hit: T; otherBranchCount: number }> = []
  for (const hit of ranked) {
    const group = groups.get(keyOf(hit))!
    // Every hit from the winning session survives: two messages in ONE session
    // that happen to read the same are two real results. Only cross-session
    // branch copies collapse.
    if (hit.sessionId !== group.winner) continue
    out.push({ hit, otherBranchCount: group.others.size })
  }
  return out
}

/** Hits from rows the indexer has not written yet. */
function pendingHits(rows: readonly ChatSearchTextRow[], needle: string): CorpusHit[] {
  const hits: CorpusHit[] = []
  for (const row of rows) {
    const occurrences = findOccurrences(row.text.toLowerCase(), needle)
    if (occurrences.length === 0) continue
    hits.push({ row, at: occurrences[0], count: occurrences.length })
  }
  return hits
}

/**
 * Search the chat history.
 *
 * Case-insensitive substring matching — the same semantics the previous
 * implementation had and that find-in-conversation still has, so a needle inside
 * an identifier (`Memo` in `useMemo`) keeps matching. A token index would have
 * quietly dropped that.
 */
export async function searchChatHistory(
  {
    query,
    limit = DEFAULT_SEARCH_LIMIT,
    projectId,
    includeArchived = false,
    collapseBySession = false,
    roles,
    after,
    before,
  }: ChatSearchQuery,
  overrides: Partial<ChatSearchDeps> & ScoreOptions = {}
): Promise<ChatSearchOutcome> {
  const deps = { ...defaultDeps(), ...overrides }
  const needle = query.trim().toLowerCase()
  if (!needle || limit <= 0) {
    return { results: [], moreOlderHistory: false, indexIncomplete: false }
  }

  const indexIncomplete = !(await deps.isIndexComplete())
  // Role / date filters reject candidates after the corpus produced them, the
  // same way exposure and archive do — so widen the over-fetch when one is on,
  // or a page of assistant-only hits would starve a `from:user` query.
  const roleSet = roles && roles.length > 0 ? new Set(roles) : null
  const hasRowFilter = roleSet !== null || after !== undefined || before !== undefined
  const want = limit * OVERFETCH * (hasRowFilter ? OVERFETCH : 1)

  const corpus = await deps.loadCorpus()
  // Pending rows first: the message that just streamed in is the one a user is
  // most likely searching for, and it is the one not yet in the corpus.
  const seen = new Set<string>()
  const hits: CorpusHit[] = []
  for (const hit of [...pendingHits(deps.pendingRows(), needle), ...corpus.search(needle, want)]) {
    if (seen.has(hit.row.messageId)) continue
    seen.add(hit.row.messageId)
    hits.push(hit)
  }

  // Older history only when the resident corpus could not fill the page.
  let moreOlderHistory = false
  const boundary = corpus.oldestResidentAt
  if (hits.length < want && boundary !== null) {
    await deps.scanOlder(boundary, (row) => {
      if (seen.has(row.messageId)) return true
      const occurrences = findOccurrences(row.text.toLowerCase(), needle)
      if (occurrences.length > 0) {
        seen.add(row.messageId)
        hits.push({ row, at: occurrences[0], count: occurrences.length })
      }
      if (hits.length >= want) {
        moreOlderHistory = true
        return false
      }
      return true
    })
  } else if (boundary !== null) {
    // Filled the page from resident text alone, so older history is untouched.
    moreOlderHistory = true
  }

  if (hits.length === 0) {
    return { results: [], moreOlderHistory, indexIncomplete }
  }

  const rows = await deps.getSessions([...new Set(hits.map((h) => h.row.sessionId))])
  const sessions = new Map<string, ChatSession>()
  for (const row of rows) {
    if (row) sessions.set(row.id, row)
  }

  const scorable = hits.flatMap((hit) => {
    if (roleSet && !roleSet.has(hit.row.role)) return []
    if (after !== undefined && hit.row.createdAt < after) return []
    if (before !== undefined && hit.row.createdAt >= before) return []
    const session = sessions.get(hit.row.sessionId)
    // A hit whose session is gone is a stale projection, not a result.
    if (!session) return []
    // `subagent` transcripts and embedded workbench sessions are never listed —
    // the same contract the sidebar and the connector bridge already honour.
    if (!isSessionExposed(session, "global-search")) return []
    const archived = session.archivedAt != null
    if (archived && !includeArchived) return []
    if (projectId !== undefined && (session.projectId ?? "") !== projectId) return []
    return [
      {
        messageId: hit.row.messageId,
        sessionId: hit.row.sessionId,
        sessionTitle: session.title,
        projectId: session.projectId ?? hit.row.projectId,
        role: hit.row.role,
        createdAt: hit.row.createdAt,
        count: hit.count,
        at: hit.at,
        titleMatched: (session.title ?? "").toLowerCase().includes(needle),
        archived,
        text: hit.row.text,
      },
    ]
  })

  const roots = await resolveRoots(sessions, deps.getSessions)

  // Dedupe before projecting to results: the fold needs the full text, and
  // building snippets for rows about to be discarded is wasted work.
  const deduped = dedupeBranchCopies(rankHits(scorable, overrides), roots)
  const surfaced = collapseBySession
    ? deduped.filter(
        (() => {
          const seenSessionIds = new Set<string>()
          return ({ hit }) => {
            if (seenSessionIds.has(hit.sessionId)) return false
            seenSessionIds.add(hit.sessionId)
            return true
          }
        })()
      )
    : deduped

  const results = surfaced.slice(0, limit).map(({ hit, otherBranchCount }): ChatSearchResult => ({
    messageId: hit.messageId,
    sessionId: hit.sessionId,
    sessionTitle: hit.sessionTitle,
    projectId: hit.projectId,
    role: hit.role,
    createdAt: hit.createdAt,
    count: hit.count,
    at: hit.at,
    snippet: buildSnippet(hit.text, needle),
    score: hit.score,
    archived: hit.archived,
    otherBranchCount,
  }))

  return {
    results,
    moreOlderHistory: moreOlderHistory || surfaced.length > limit,
    indexIncomplete,
  }
}
