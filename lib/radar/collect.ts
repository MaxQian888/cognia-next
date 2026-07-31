/**
 * Gather + PII-gate + pre-filter the items the Attention Radar analyzes.
 *
 * Primary source: the autonomous long-term memory store (`lib/db/memories.ts`)
 * — already deduped, importance-weighted, and PII-redacted at write time, so it
 * is the cleanest "what the user has been engaging with" signal. Phase 4's
 * captured items fold in through `opts.extra`.
 *
 * We intentionally do NOT scrape raw chat messages / clipboard buffer / OCR
 * cache here: those are high-noise and (clipboard/OCR) not a chronological
 * consumption log — memories already distill them. Every item still passes
 * through `hasNoLeakingPii` as a belt-and-suspenders gate before it can reach
 * the model.
 */

import { listMemories } from "@/lib/db/memories"
import { listCapturedItemsSince } from "@/lib/db/captured-items"
import { hasNoLeakingPii } from "@cognia/redact"
import { smartPreFilter } from "./prefilter"
import type { RadarDataItem } from "@/types/radar"

const DAY_MS = 86_400_000

export interface CollectRadarOptions {
  /** Activity window in days. Default 14. */
  windowDays?: number
  /** Cap on items sent to the analyzer. Default 60. */
  maxItems?: number
  /** Injected clock for deterministic tests. */
  now?: number
  /** Extra pre-normalized items (e.g. Phase 4 captured items). */
  extra?: RadarDataItem[]
}

export async function collectRadarItems(opts: CollectRadarOptions = {}): Promise<RadarDataItem[]> {
  const windowDays = opts.windowDays ?? 14
  const maxItems = opts.maxItems ?? 60
  const now = opts.now ?? Date.now()
  const cutoff = now - windowDays * DAY_MS

  const memories = await listMemories({ status: "active" })
  const memItems: RadarDataItem[] = memories
    .filter((m) => m.updatedAt >= cutoff)
    .map((m) => ({
      id: m.id,
      text: m.text,
      source: "memory" as const,
      at: m.updatedAt,
      importance: m.importance,
      kind: m.type,
    }))

  // Captured items (Phase 4) — the enrichment markdown/title carries the most
  // signal; fall back to the raw text/URL.
  const captures = await listCapturedItemsSince(cutoff)
  const capItems: RadarDataItem[] = captures.map((c) => ({
    id: c.id,
    text: c.enrichment?.markdown || c.text || c.sourceUrl || "",
    source: "capture" as const,
    at: c.capturedAt,
    kind: c.kind,
  }))

  const extra = (opts.extra ?? []).filter((i) => i.at >= cutoff)

  // Belt-and-suspenders PII gate before anything reaches the model.
  const safe = [...memItems, ...capItems, ...extra].filter(
    (i) => i.text.trim().length > 0 && hasNoLeakingPii(i.text)
  )

  return smartPreFilter(safe, maxItems)
}

/**
 * Local capture-activity heatmap — a per-day count over the window. Computed
 * here (not by the LLM) so it is always accurate.
 */
export function computeHeatmap(
  items: readonly RadarDataItem[],
  windowDays: number,
  now: number
): { day: string; count: number }[] {
  const cells = new Map<string, number>()
  for (let d = windowDays - 1; d >= 0; d--) {
    const day = new Date(now - d * DAY_MS).toISOString().slice(0, 10)
    cells.set(day, 0)
  }
  for (const item of items) {
    const day = new Date(item.at).toISOString().slice(0, 10)
    if (cells.has(day)) cells.set(day, (cells.get(day) ?? 0) + 1)
  }
  return Array.from(cells, ([day, count]) => ({ day, count }))
}
