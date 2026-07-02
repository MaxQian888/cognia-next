/**
 * Attention Radar — a periodic AI "info-diet" analysis over the user's recent
 * activity (long-term memories + captured items). Produces a 7-dimension
 * `RadarReport` surfaced in the pet console and teased via a pet bubble.
 *
 * Inspired by OpenWiki's Radar Report, adapted to cognia's data (memories are
 * already PII-redacted; the report is regenerated on a schedule).
 */

/** Where an analyzed item came from. */
export type RadarDataSource = "memory" | "capture"

/** One normalized item fed to the analyzer. */
export interface RadarDataItem {
  id: string
  /** Redacted/plain text of the item. */
  text: string
  source: RadarDataSource
  /** Epoch ms the item was created / last touched. */
  at: number
  /** 1..10 salience when known (memory importance); undefined otherwise. */
  importance?: number
  /** Sub-kind, e.g. the memory type or capture kind. */
  kind?: string
}

/** A "forgotten but valuable" item worth revisiting. */
export interface RadarGraveyardItem {
  /** 0-based index into the analyzed item list — lets the UI link back. */
  index: number
  /** Why it is worth re-reading. */
  reason: string
}

export interface RadarTopic {
  topic: string
  /** Relative weight 0..1. */
  weight: number
}

/** One day's capture-activity count (locally computed, not from the LLM). */
export interface RadarHeatCell {
  /** ISO date (YYYY-MM-DD). */
  day: string
  count: number
}

/**
 * The LLM-authored portion of a report. The model returns exactly this shape
 * (validated via `extractJson`); the runner wraps it with local metadata +
 * heatmap into a {@link RadarReport}.
 */
export interface RadarLlmOutput {
  /** One-line opinionated summary. */
  verdict: string
  /** 2–3 high-level highlights. */
  atAGlance: string[]
  /** Quantitative breakdown of sources / depth / dominant topics. */
  infoDiet: string
  /** Interests the user may not consciously realize (with evidence). */
  subconscious: string
  /** High-value forgotten items worth re-reading. */
  graveyard: RadarGraveyardItem[]
  /** Neglected angles / contradictions. */
  blindSpots: string
  /** Concrete next actions. */
  actions: string[]
  /** Topic distribution. */
  topicCloud: RadarTopic[]
}

/** A persisted radar report (one row in the `radarReports` table). */
export interface RadarReport extends RadarLlmOutput {
  id: string
  /** Analysis scope — currently always "self". */
  scope: string
  generatedAt: number
  /** Days of activity analyzed. */
  windowDays: number
  /** Number of items analyzed. */
  itemCount: number
  /** Capture-activity distribution over the window (computed locally). */
  heatmap: RadarHeatCell[]
}

export type RadarScheduleMode = "off" | "daily" | "weekly" | "custom"

export interface RadarScheduleSettings {
  mode: RadarScheduleMode
  /** Required when `mode === "custom"`. 5-field cron. */
  customCron?: string
  /** Optional IANA timezone. */
  timezone?: string
}

export interface RadarSettings {
  /** Master switch for auto-generation + pet teasers. */
  enabled: boolean
  /** Minimum days between auto reports (skip if the last one is newer). */
  intervalDays: number
  /** Activity window (days) to analyze. */
  windowDays: number
  /** Cron schedule for background generation. */
  schedule?: RadarScheduleSettings
}

export const DEFAULT_RADAR_SETTINGS: RadarSettings = {
  enabled: false,
  intervalDays: 3,
  windowDays: 14,
}

/** Minimum items required before a report is worth generating. */
export const RADAR_MIN_ITEMS = 5
