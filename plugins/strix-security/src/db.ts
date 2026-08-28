// Typed Dexie helpers over the plugin-private tables (runs / findings / prefs).
// Every table access goes through `ctx.dexie`, which namespaces to
// `strix-security:<table>` — see lib/plugin/api/dexie-api.ts.

import { findingKey, targetKey } from "@cognia/plugin-sdk/api/security-findings"
import type { PluginDexieAPI } from "@cognia/plugin-sdk"
import type { Table } from "dexie"
import type {
  FindingState,
  FindingStateRow,
  StrixFinding,
  StrixRun,
  SuppressionRule,
} from "./types"

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

/**
 * Wipe all runs + findings + triage.
 *
 * Triage is keyed by TARGET, not by run, so deleting one run deliberately
 * leaves it alone — a decision about a vulnerability outlives the particular
 * scan that first reported it. "Clear all" is the other case: the user asked
 * for everything to be gone, and leaving verdicts about targets behind would
 * be exactly the kind of residue the artifact purge already exists to avoid.
 */
export async function clearAllRuns(dexie: PluginDexieAPI): Promise<void> {
  await runsTable(dexie).clear()
  await findingsTable(dexie).clear()
  await findingStatesTable(dexie).clear()
  await suppressionRulesTable(dexie).clear()
}

// ------------------------------------------------------------------ triage

export function findingStatesTable(dexie: PluginDexieAPI): Table<FindingStateRow, string> {
  return dexie.table<FindingStateRow, string>("findingStates")
}

export function suppressionRulesTable(dexie: PluginDexieAPI): Table<SuppressionRule, string> {
  return dexie.table<SuppressionRule, string>("suppressionRules")
}

/** Every triage decision recorded for one scan target. */
export function listFindingStates(
  dexie: PluginDexieAPI,
  target: string
): Promise<FindingStateRow[]> {
  return findingStatesTable(dexie).where("target").equals(targetKey(target)).toArray()
}

/**
 * Record (or clear) a verdict on one finding.
 *
 * `open` deletes the row rather than storing it: open is the absence of a
 * decision, and persisting it would make "never triaged" and "looked at and
 * left open" indistinguishable in every count.
 */
export async function setFindingState(
  dexie: PluginDexieAPI,
  input: { target: string; fingerprint: string; state: FindingState; note?: string; now: number }
): Promise<void> {
  const target = targetKey(input.target)
  const key = findingKey(target, input.fingerprint)
  if (input.state === "open") {
    await findingStatesTable(dexie).delete(key)
    return
  }
  await findingStatesTable(dexie).put({
    key,
    target,
    fingerprint: input.fingerprint,
    state: input.state,
    ...(input.note ? { note: input.note } : {}),
    updatedAt: input.now,
  })
}

export function listSuppressionRules(
  dexie: PluginDexieAPI,
  target: string
): Promise<SuppressionRule[]> {
  return suppressionRulesTable(dexie).where("target").equals(targetKey(target)).toArray()
}

export function suppressionRuleId(target: string, ruleId: string): string {
  return `${targetKey(target)}::${ruleId}`
}

export async function addSuppressionRule(
  dexie: PluginDexieAPI,
  input: { target: string; ruleId: string; reason?: string; now: number }
): Promise<void> {
  const target = targetKey(input.target)
  await suppressionRulesTable(dexie).put({
    id: suppressionRuleId(input.target, input.ruleId),
    target,
    ruleId: input.ruleId,
    ...(input.reason ? { reason: input.reason } : {}),
    createdAt: input.now,
  })
}

export async function removeSuppressionRule(dexie: PluginDexieAPI, id: string): Promise<void> {
  await suppressionRulesTable(dexie).delete(id)
}

export async function getPref(dexie: PluginDexieAPI, key: string): Promise<string | undefined> {
  const row = await prefsTable(dexie).get(key)
  return row?.value
}

export async function setPref(dexie: PluginDexieAPI, key: string, value: string): Promise<void> {
  await prefsTable(dexie).put({ key, value })
}
