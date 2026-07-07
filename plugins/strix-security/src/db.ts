// Typed Dexie helpers over the plugin-private tables (runs / findings / prefs).
// Every table access goes through `ctx.dexie`, which namespaces to
// `strix-security:<table>` — see lib/plugin/api/dexie-api.ts.

import type { PluginDexieAPI } from "@/lib/plugin/api/dexie-api"
import type { Table } from "dexie"
import type { StrixFinding, StrixRun } from "./types"

interface PrefRow {
  key: string
  value: string
}

export function runsTable(dexie: PluginDexieAPI): Table<StrixRun, string> {
  return dexie.table<StrixRun, string>("runs")
}

export function findingsTable(dexie: PluginDexieAPI): Table<StrixFinding, number> {
  return dexie.table<StrixFinding, number>("findings")
}

export function prefsTable(dexie: PluginDexieAPI): Table<PrefRow, string> {
  return dexie.table<PrefRow, string>("prefs")
}

/** All runs, newest first. */
export function listRuns(dexie: PluginDexieAPI): Promise<StrixRun[]> {
  return runsTable(dexie).orderBy("startedAt").reverse().toArray()
}

/** Findings for one run, most-severe first is applied by the caller. */
export function listFindings(dexie: PluginDexieAPI, runId: string): Promise<StrixFinding[]> {
  return findingsTable(dexie).where("runId").equals(runId).toArray()
}

/** Delete a run and its findings atomically. */
export async function deleteRun(dexie: PluginDexieAPI, runId: string): Promise<void> {
  await runsTable(dexie).delete(runId)
  await findingsTable(dexie).where("runId").equals(runId).delete()
}

/** Wipe all runs + findings. */
export async function clearAllRuns(dexie: PluginDexieAPI): Promise<void> {
  await runsTable(dexie).clear()
  await findingsTable(dexie).clear()
}

export async function getPref(dexie: PluginDexieAPI, key: string): Promise<string | undefined> {
  const row = await prefsTable(dexie).get(key)
  return row?.value
}

export async function setPref(dexie: PluginDexieAPI, key: string, value: string): Promise<void> {
  await prefsTable(dexie).put({ key, value })
}
