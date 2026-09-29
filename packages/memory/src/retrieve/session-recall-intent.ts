/**
 * Session-recall intent — does the query ask about a past conversation?
 *
 * "What did we decide last time about the cache?" wants an EPISODE, not a
 * general fact about caches, but lexical and vector relevance rank the two the
 * same. ai-memory measured this (hit@1 on session-recall questions 0.14 → 0.71)
 * and routes such queries toward session pages; here the episodic memories play
 * that role. Ported from `retrieval_tuning.rs::is_session_recall_query`.
 *
 * Chinese markers match as substrings (no word boundaries in CJK). English
 * markers match on word boundaries after non-alphanumerics become spaces, so
 * "yesterday's" matches and "subsequently" does not.
 *
 * Pure.
 */

const CJK_MARKERS = [
  "之前",
  "上次",
  "上回",
  "上一次",
  "那次",
  "那回",
  "前几天",
  "前天",
  "昨天",
  "那天",
  "上周",
  "上星期",
  "上个月",
  "的会话",
  "次会话",
  "个会话",
  "会话里",
  "会话中",
  "历史会话",
  "当时我们",
  "我们当时",
] as const

const EN_MARKERS = [
  "last time",
  "last session",
  "previous session",
  "earlier session",
  "that session",
  "the session where",
  "yesterday",
  "the other day",
  "last week",
  "when we",
  "we did",
  "did we",
  "what did we",
  "how did we",
  "back then",
  "earlier we",
  "previously",
] as const

/**
 * Multiplicative boost (`score × 1.25`) for episodic hits when the query has
 * session-recall intent — ai-memory's +0.25 on its authority multiplier.
 */
export const SESSION_RECALL_EPISODIC_BOOST = 0.25

export function isSessionRecallQuery(query: string): boolean {
  const lower = query.toLocaleLowerCase()
  if (CJK_MARKERS.some((marker) => lower.includes(marker))) return true
  const padded = ` ${lower.replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `
  return EN_MARKERS.some((marker) => padded.includes(` ${marker} `))
}
