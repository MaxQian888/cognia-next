/**
 * Relevance scoring for chat-history hits.
 *
 * Structurally this mirrors `packages/memory/src/retrieve/scoring.ts` — normalise
 * each signal to 0..1, take a weighted sum, sort descending — with one
 * deliberate departure: **normalisation here is absolute, not min-max over the
 * candidate set.**
 *
 * That difference is load-bearing. Search results arrive in two waves: the local
 * corpus answers immediately, then the host's results merge in. Min-max scoring
 * makes every score a function of the whole candidate list, so the second wave
 * would re-rank the rows already under the user's cursor. Absolute scoring means
 * a hit's score never changes when other hits appear, so merging only interleaves.
 *
 * There is no IDF term. Document frequency would need a statistics table kept in
 * step with every write, and the signals below are already the ones a reader
 * actually uses to recognise the right conversation. Everything here is a
 * by-product of the verification pass that had to run anyway.
 */

/** Age at which the recency signal halves. */
export const RECENCY_HALF_LIFE_DAYS = 30

/** Match offset (chars) at which the position signal halves. */
const POSITION_HALF_LIFE_CHARS = 200

const MS_PER_DAY = 86_400_000

export interface ScorableHit {
  /** Tie-breaker of last resort — the order must be total. */
  messageId: string
  /** Occurrences of the needle in this message. */
  count: number
  /** Offset of the first occurrence within the message text. */
  at: number
  createdAt: number
  role: string
  /** Whether the owning session's title also matched. */
  titleMatched: boolean
}

export interface ScoreWeights {
  count: number
  position: number
  title: number
  recency: number
  role: number
}

/**
 * Recency outweighs raw occurrence count: in a chat log, "the conversation I had
 * last week" beats "the conversation that said it most times".
 */
export const DEFAULT_SCORE_WEIGHTS: ScoreWeights = {
  count: 1,
  position: 0.4,
  title: 0.8,
  recency: 1.2,
  role: 0.2,
}

export interface HitScoreParts {
  count: number
  position: number
  title: number
  recency: number
  role: number
}

export interface ScoreOptions {
  now?: number
  weights?: ScoreWeights
}

/**
 * A user's own words are the better landmark — people remember what they asked
 * more reliably than how the model phrased its answer. System messages carry
 * prompt scaffolding nobody searches for on purpose.
 */
function roleSignal(role: string): number {
  if (role === "user") return 1
  if (role === "assistant") return 0.5
  return 0
}

/** Saturating: 1 → 0.5, 10 → 0.91, so no single message runs away with the list. */
function countSignal(count: number): number {
  if (count <= 0) return 0
  return 1 - 1 / (1 + count)
}

function positionSignal(at: number): number {
  return 1 / (1 + Math.max(0, at) / POSITION_HALF_LIFE_CHARS)
}

function recencySignal(createdAt: number, now: number): number {
  // Clamped at 0: a future timestamp is clock skew, not extra relevance. The
  // date bucketing in `conversation-list-model` clamps for the same reason.
  const ageDays = Math.max(0, (now - createdAt) / MS_PER_DAY)
  return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS)
}

/** Score one hit. Independent of every other hit — see the module note. */
export function scoreHit(
  hit: ScorableHit,
  { now = Date.now(), weights = DEFAULT_SCORE_WEIGHTS }: ScoreOptions = {}
): { score: number; parts: HitScoreParts } {
  const parts: HitScoreParts = {
    count: countSignal(hit.count),
    position: positionSignal(hit.at),
    title: hit.titleMatched ? 1 : 0,
    recency: recencySignal(hit.createdAt, now),
    role: roleSignal(hit.role),
  }
  const score =
    weights.count * parts.count +
    weights.position * parts.position +
    weights.title * parts.title +
    weights.recency * parts.recency +
    weights.role * parts.role
  return { score, parts }
}

/**
 * Rank hits best-first, preserving each caller's own fields.
 *
 * Ties break on recency then `messageId` so the ordering is **total**. Without
 * that, two equally-scored rows can swap places on any re-render — the defect
 * `byRecent` in `lib/chat/conversation-list-model.ts` exists to prevent, and it
 * is more visible here because the list re-renders as remote results merge in.
 */
export function rankHits<T extends ScorableHit>(
  hits: readonly T[],
  options: ScoreOptions = {}
): Array<T & { score: number; parts: HitScoreParts }> {
  return hits
    .map((hit) => ({ ...hit, ...scoreHit(hit, options) }))
    .sort(
      (a, b) =>
        b.score - a.score || b.createdAt - a.createdAt || a.messageId.localeCompare(b.messageId)
    )
}
