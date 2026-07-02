/**
 * Attention Radar runner — orchestrates collect → generate → persist.
 *
 * Guards (mirroring OpenWiki): skip when fewer than `RADAR_MIN_ITEMS` items are
 * available, or when the last report is newer than `intervalDays` (unless
 * `force`). Reads settings + resolves the utility LLM client the same way the
 * conversation-title generator does.
 */

import { getSettings } from "@/lib/db/settings"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { collectRadarItems, computeHeatmap } from "./collect"
import { generateRadarReport } from "./generate"
import { getLatestRadarReport, saveRadarReport, pruneRadarReports } from "@/lib/db/radar-reports"
import { DEFAULT_RADAR_SETTINGS, RADAR_MIN_ITEMS, type RadarReport } from "@/types/radar"

const DAY_MS = 86_400_000

/** Thrown when no renderer-side LLM key resolves for the radar. */
export class NoRadarModelError extends Error {
  constructor(message = "No LLM API key configured for the attention radar.") {
    super(message)
    this.name = "NoRadarModelError"
  }
}

export interface RunRadarOptions {
  /** Bypass the interval + skip guards (the "Run now" button). */
  force?: boolean
  /** Injected clock for tests. */
  now?: number
}

function newReportId(now: number): string {
  return `radar_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Generate a radar report. Returns the saved report, or `null` when a guard
 * skipped generation (too soon since the last report, or too few items).
 * Throws {@link NoRadarModelError} when no model key is available.
 */
export async function runRadarReport(opts: RunRadarOptions = {}): Promise<RadarReport | null> {
  const settings = await getSettings()
  const radar = settings?.attentionRadar ?? DEFAULT_RADAR_SETTINGS
  const now = opts.now ?? Date.now()
  const windowDays = radar.windowDays ?? DEFAULT_RADAR_SETTINGS.windowDays
  const intervalDays = radar.intervalDays ?? DEFAULT_RADAR_SETTINGS.intervalDays

  if (!opts.force) {
    const latest = await getLatestRadarReport("self")
    if (latest && now - latest.generatedAt < intervalDays * DAY_MS) {
      return null
    }
  }

  const items = await collectRadarItems({ windowDays, now })
  if (items.length < RADAR_MIN_ITEMS) return null

  const client = buildUtilityLlmClient({
    session: null,
    appSettings: settings,
    featureId: "attention-radar",
  })
  if (!client) throw new NoRadarModelError()

  const out = await generateRadarReport(client, { items, locale: settings?.language })
  const report: RadarReport = {
    id: newReportId(now),
    scope: "self",
    generatedAt: now,
    windowDays,
    itemCount: items.length,
    heatmap: computeHeatmap(items, windowDays, now),
    ...out,
  }
  await saveRadarReport(report)
  await pruneRadarReports()
  return report
}
