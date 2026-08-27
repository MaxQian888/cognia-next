/**
 * Incident persistence over the plugin-private Dexie namespace.
 *
 * `ctx.dexie` namespaces every table to `sre-agent:<name>`, so the rows here
 * are unreachable from the host schema and from other plugins; the table is
 * declared in `plugin.json` under `dexie.tables` (an undeclared name is a
 * Dexie lookup error at call time, not a silent empty table).
 *
 * Local-only by design. An incident holds redacted evidence copies and a
 * timeline drafted against them; syncing that to another device would move
 * production log excerpts off the machine that was authorised to read them.
 */

import type { Table } from "dexie"
import type { PluginDexieAPI } from "@/lib/plugin/api/dexie-api"
import { compareIncidents, type SreIncident } from "./model"

export const INCIDENTS_TABLE = "incidents"

export function incidentsTable(dexie: PluginDexieAPI): Table<SreIncident, string> {
  return dexie.table<SreIncident, string>(INCIDENTS_TABLE)
}

/** Every incident, open work first then most recently touched. */
export async function listIncidents(dexie: PluginDexieAPI): Promise<SreIncident[]> {
  const rows = await incidentsTable(dexie).toArray()
  return rows.sort(compareIncidents)
}

/**
 * Incidents opened from one chat session, plus every incident that belongs to
 * no session at all.
 *
 * The unscoped ones are included on purpose: an incident created by an alert
 * has no session, and scoping it away would make the panel look empty exactly
 * when something is on fire.
 */
export async function listIncidentsForSession(
  dexie: PluginDexieAPI,
  sessionId: string
): Promise<SreIncident[]> {
  const rows = await listIncidents(dexie)
  return rows.filter((incident) => !incident.sessionId || incident.sessionId === sessionId)
}

export async function getIncident(
  dexie: PluginDexieAPI,
  id: string
): Promise<SreIncident | undefined> {
  return incidentsTable(dexie).get(id)
}

export async function putIncident(dexie: PluginDexieAPI, incident: SreIncident): Promise<void> {
  await incidentsTable(dexie).put(incident)
}

export async function deleteIncident(dexie: PluginDexieAPI, id: string): Promise<void> {
  await incidentsTable(dexie).delete(id)
}

export async function clearIncidents(dexie: PluginDexieAPI): Promise<void> {
  await incidentsTable(dexie).clear()
}
