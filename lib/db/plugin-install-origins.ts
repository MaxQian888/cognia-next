// Plugin install origins (Dexie v235, ADR-0209).
//
// One row per installed plugin, keyed by plugin id, recording where it came
// from pinned to what was actually installed. Kept in its own table rather than
// on the `plugins` row for two reasons: several installers never write that row
// themselves (the HTTP registry path leaves it to the next discovery pass), and
// discovery re-projects the row on every launch. An origin written beside the
// row survives both.

import type { PluginInstallOriginRecord } from "@/types/plugin/plugin-cogset"

import { getDb } from "./schema"

export async function getInstallOrigin(
  pluginId: string
): Promise<PluginInstallOriginRecord | undefined> {
  return getDb().pluginInstallOrigins.get(pluginId)
}

/** Replace the origin for `record.pluginId`. A reinstall always supersedes. */
export async function putInstallOrigin(record: PluginInstallOriginRecord): Promise<void> {
  await getDb().pluginInstallOrigins.put(record)
}
