/**
 * Cross-provider relevance (ADR-0129).
 *
 * Every provider hands the engine a `score ∈ [0, 1]`. Title-like items share
 * one scorer so a conversation, a workflow and a settings page that all match
 * "deploy" compete on equal footing.
 *
 * The score is TIERED. Each kind of match owns a disjoint band of the scale
 * (`MATCH_TIER_BANDS`), strongest first:
 *
 *   exact title > exact keyword > title prefix > title word-start
 *   > title substring > secondary text > keyword prefix > keyword substring
 *   > fuzzy subsequence
 *
 * Recency and title coverage only move an item INSIDE its band. They used to
 * be added on top of a flat per-kind base, so a fresh chat whose title merely
 * contained the query (0.9 + up to 0.15 of recency) outscored the page whose
 * title IS the query, and a keyword that equalled the query scored a flat 0.28
 * (the zh-CN "记忆" page only matches "memory" through its keyword). Searching
 * "memory" ranked recent chats, messages and pages above every Memory entry.
 *
 * Bands are separated by `TIER_GAP`, wider than any provider's own nudge
 * (the actions provider's +0.03 primary boost, the settings control −0.02),
 * so `matchTierOfScore` still reads the right tier back from a nudged score.
 * The engine orders groups by that tier first (`orderGroups`).
 *
 * The chat-message engine keeps its own absolute score (ADR-0099); the message
 * provider maps it into a band that tops out at title-substring
 * (`normalizeMessageScore`): a body hit is never stronger than a title that
 * starts with, or is, the query.
 */

import { fuzzyMatch } from "@/lib/chat/completion/fuzzy-match"
import { titleMatchRank } from "@/lib/chat/conversation-list-model"

/** Recency half-life used for tie-breaking (days). */
export const RECENCY_HALF_LIFE_DAYS = 14

const DAY_MS = 86_400_000

/** Fuzzy floor: `fuzzyMatch` gives 1 per char + bonuses; require ≥ 2 per char. */
const FUZZY_MIN_SCORE_PER_CHAR = 2

/** The historical default cap on recency; `recencyWeight` is read relative to it. */
const DEFAULT_RECENCY_WEIGHT = 0.15

/** How a query matched an item, strongest first. */
export type MatchTier =
  | "exact"
  | "keyword-exact"
  | "prefix"
  | "word"
  | "substring"
  | "secondary"
  | "keyword-prefix"
  | "keyword"
  | "fuzzy"

/** Tiers in rank order: index 0 is the strongest. */
export const MATCH_TIER_ORDER: readonly MatchTier[] = [
  "exact",
  "keyword-exact",
  "prefix",
  "word",
  "substring",
  "secondary",
  "keyword-prefix",
  "keyword",
  "fuzzy",
]

/** Minimum distance between one band's ceiling and the next band's floor. */
export const TIER_GAP = 0.06

/** How far below its floor a nudged score still reads as that tier. */
const TIER_TOLERANCE = 0.025

/** `[floor, ceiling]` per tier. Disjoint, `TIER_GAP` apart, strongest highest. */
export const MATCH_TIER_BANDS: Readonly<Record<MatchTier, readonly [number, number]>> = {
  exact: [0.96, 1],
  "keyword-exact": [0.88, 0.9],
  prefix: [0.78, 0.82],
  word: [0.66, 0.72],
  substring: [0.54, 0.6],
  secondary: [0.4, 0.48],
  "keyword-prefix": [0.3, 0.34],
  keyword: [0.2, 0.24],
  fuzzy: [0, 0.14],
}

/**
 * Read the tier back from a (possibly provider-nudged) score. Scores below
 * every band (a demoted row, an empty-query suggestion ordinal) read as fuzzy.
 */
export function matchTierOfScore(score: number): MatchTier {
  for (const tier of MATCH_TIER_ORDER) {
    if (score >= MATCH_TIER_BANDS[tier][0] - TIER_TOLERANCE) return tier
  }
  return "fuzzy"
}

/** Rank index of a tier (0 = strongest), for sorting. */
export function matchTierRank(tier: MatchTier): number {
  return MATCH_TIER_ORDER.indexOf(tier)
}

/** Place `position ∈ [0, 1]` inside `tier`'s band. */
function inBand(tier: MatchTier, position: number): number {
  const [floor, ceiling] = MATCH_TIER_BANDS[tier]
  const clamped = Math.min(1, Math.max(0, position))
  return floor + (ceiling - floor) * clamped
}

export interface TitleMatch {
  score: number
  /** Indices in the *primary* text that matched (for highlighting). */
  positions: number[]
  /** Which text produced the winning tier: primary title or a secondary field. */
  field: "title" | "secondary" | "keyword"
  /** The winning match tier; `score` lies inside its band. */
  tier: MatchTier
}

export interface TitleMatchOptions {
  /** Description / subtitle searched when the title misses. */
  secondary?: string
  /** Hidden tokens (aliases, ids, tags). An exact keyword is a strong match. */
  keywords?: readonly string[]
  /** Record timestamp — moves a fresh item up inside its tier's band. */
  timestamp?: number
  now?: number
  /**
   * Weight of recency inside a band, relative to the default 0.15. Recency can
   * never lift an item into a stronger tier, whatever the weight.
   */
  recencyWeight?: number
  /**
   * Allow fuzzy subsequence matches when no substring hit exists. Default
   * true. Providers over free prose (memories) turn it off — a subsequence in
   * a paragraph is noise.
   */
  fuzzy?: boolean
}

/** Positions of `needle` inside `haystack` (case-insensitive), first hit only. */
export function substringPositions(haystack: string, needle: string): number[] {
  const at = haystack.toLowerCase().indexOf(needle)
  if (at < 0) return []
  return Array.from({ length: needle.length }, (_, i) => at + i)
}

/** 0..1 recency bonus, 1 for "now", ½ after one half-life. */
export function recencyBonus(timestamp: number | undefined, now: number): number {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return 0
  const ageDays = Math.max(0, now - timestamp) / DAY_MS
  return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS)
}

function coverage(text: string, needle: string): number {
  return text.length > 0 ? Math.min(1, needle.length / text.length) : 0
}

const TITLE_RANK_TIER: Record<number, MatchTier> = { 0: "prefix", 1: "word", 2: "substring" }

/** The best keyword tier among `keywords`, with the keyword that earned it. */
function bestKeyword(
  keywords: readonly string[],
  needle: string
): { tier: MatchTier; keyword: string } | null {
  let best: { tier: MatchTier; keyword: string } | null = null
  for (const raw of keywords) {
    const keyword = raw.trim().toLowerCase()
    if (!keyword) continue
    const tier: MatchTier | null =
      keyword === needle
        ? "keyword-exact"
        : keyword.startsWith(needle)
          ? "keyword-prefix"
          : keyword.includes(needle)
            ? "keyword"
            : null
    if (tier && (!best || matchTierRank(tier) < matchTierRank(best.tier))) {
      best = { tier, keyword }
      if (tier === "keyword-exact") break
    }
  }
  return best
}

/**
 * Score a title-like item against a lower-cased needle. Returns `null` when
 * nothing matched (the item is dropped). The strongest matching tier wins, so
 * an alias that IS the query outranks a title that merely starts with it.
 */
export function scoreTitleMatch(
  needle: string,
  title: string,
  {
    secondary,
    keywords,
    timestamp,
    now = Date.now(),
    recencyWeight = DEFAULT_RECENCY_WEIGHT,
    fuzzy = true,
  }: TitleMatchOptions = {}
): TitleMatch | null {
  const bonus = recencyBonus(timestamp, now)
  if (!needle) {
    return {
      score: Math.min(1, 0.5 + bonus * recencyWeight),
      positions: [],
      field: "title",
      tier: "substring",
    }
  }
  // Recency's share of a band, scaled by the caller's weight and capped at 1.
  const recency = Math.min(1, bonus * (recencyWeight / DEFAULT_RECENCY_WEIGHT))
  const within = (cover: number) => 0.5 * cover + 0.5 * recency

  const candidates: TitleMatch[] = []
  const titlePositions = substringPositions(title, needle)

  if (title.trim().toLowerCase() === needle.trim()) {
    candidates.push({
      score: inBand("exact", within(1)),
      positions: titlePositions,
      field: "title",
      tier: "exact",
    })
  } else {
    const rank = titleMatchRank(title, needle)
    if (rank !== null) {
      const tier = TITLE_RANK_TIER[rank] ?? "substring"
      candidates.push({
        score: inBand(tier, within(coverage(title, needle))),
        positions: titlePositions,
        field: "title",
        tier,
      })
    }
  }

  if (keywords && keywords.length > 0) {
    const hit = bestKeyword(keywords, needle)
    if (hit) {
      candidates.push({
        score: inBand(hit.tier, within(coverage(hit.keyword, needle))),
        // Highlight the title when it also matched, whichever field won.
        positions: titlePositions,
        field: "keyword",
        tier: hit.tier,
      })
    }
  }

  if (secondary) {
    const secondaryRank = titleMatchRank(secondary, needle)
    if (secondaryRank !== null) {
      candidates.push({
        score: inBand("secondary", 0.6 * (secondaryRank === 0 ? 1 : 0.5) + 0.4 * recency),
        positions: titlePositions,
        field: "secondary",
        tier: "secondary",
      })
    }
  }

  if (candidates.length > 0) {
    return candidates.reduce((best, next) =>
      matchTierRank(next.tier) < matchTierRank(best.tier) ||
      (next.tier === best.tier && next.score > best.score)
        ? next
        : best
    )
  }

  if (fuzzy && needle.length >= 2) {
    const match = fuzzyMatch(needle, title)
    // A subsequence scattered one letter at a time through a long title
    // ("sett" inside "Subworkflow orchestrator") is noise; demand at least a
    // boundary or consecutive-run bonus per needle character.
    if (match && match.score >= needle.length * FUZZY_MIN_SCORE_PER_CHAR) {
      // fuzzyMatch scores are unbounded; squash into [0, 1) before banding.
      const quality = 1 - Math.exp(-Math.max(0, match.score) / 12)
      return {
        score: inBand("fuzzy", 0.8 * quality + 0.2 * recency),
        positions: match.positions,
        field: "title",
        tier: "fuzzy",
      }
    }
  }

  return null
}

/** Where message hits land: from the secondary floor up to title-substring. */
export const MESSAGE_SCORE_BAND: readonly [number, number] = [
  MATCH_TIER_BANDS.secondary[0],
  MATCH_TIER_BANDS.substring[1],
]

/**
 * Map the chat engine's absolute message score into `MESSAGE_SCORE_BAND`. The
 * engine's weights sum to ≈3.6 for a perfect hit (count 1, position 0.4, title
 * 0.8, recency 1.2, role 0.2); anything above that saturates. Its recency
 * weight is the largest single term, which is how a message from today used to
 * outrank the page whose title is the query; the band caps what it can reach.
 */
export function normalizeMessageScore(score: number): number {
  if (!Number.isFinite(score) || score <= 0) return 0
  const [floor, ceiling] = MESSAGE_SCORE_BAND
  return floor + (ceiling - floor) * Math.min(1, score / 3.6)
}

/** Sort helper: score desc, then timestamp desc, then title asc. */
export function compareByScore<T extends { score: number; timestamp?: number; title: string }>(
  a: T,
  b: T
): number {
  if (b.score !== a.score) return b.score - a.score
  const ta = a.timestamp ?? 0
  const tb = b.timestamp ?? 0
  if (tb !== ta) return tb - ta
  return a.title.localeCompare(b.title)
}
