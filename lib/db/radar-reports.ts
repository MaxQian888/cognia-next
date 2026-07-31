/**
 * CRUD layer for the `radarReports` Dexie table (v96) — Attention Radar
 * output. Written by `lib/radar/radar-runner.ts`; read by the pet console
 * radar panel and the pet-insight teaser hook (both via `useLiveQuery`).
 */

import Dexie from "dexie"
import type { RadarReport } from "@/types/radar"
import { getDb } from "./schema"

export async function saveRadarReport(report: RadarReport): Promise<void> {
  await getDb().radarReports.put(report)
}

export async function getRadarReport(id: string): Promise<RadarReport | undefined> {
  return getDb().radarReports.get(id)
}

/** Most-recent report for a scope, or undefined. */
export async function getLatestRadarReport(scope = "self"): Promise<RadarReport | undefined> {
  return getDb()
    .radarReports.where("[scope+generatedAt]")
    .between([scope, Dexie.minKey], [scope, Dexie.maxKey])
    .last()
}

/** Newest-first list, capped. */
export async function listRadarReports(limit = 20): Promise<RadarReport[]> {
  return getDb().radarReports.orderBy("generatedAt").reverse().limit(limit).toArray()
}

/** Trim to the newest `keep` reports (called after each write). */
export async function pruneRadarReports(keep = 20): Promise<number> {
  const db = getDb()
  const ids = await db.radarReports.orderBy("generatedAt").reverse().offset(keep).primaryKeys()
  if (ids.length === 0) return 0
  await db.radarReports.bulkDelete(ids as string[])
  return ids.length
}
