// Imported cogpacks (Dexie v235, ADR-0209).
//
// One row per import: the manifest as it arrived, the trust it was imported
// under, the cogset it created and what could not be installed. The manifest
// is kept so a later version of the same cogpack can be diffed against it.

import type { CogpackInstallRow } from "@/types/plugin/plugin-cogset"

import { getDb } from "./schema"

export function newCogpackInstallId(): string {
  return "cogpack_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

/** Every import of one cogpack id, newest first. */
export async function listCogpackInstallsFor(cogpackId: string): Promise<CogpackInstallRow[]> {
  const rows = await getDb().cogpackInstalls.where("cogpackId").equals(cogpackId).toArray()
  return rows.sort((a, b) => b.installedAt - a.installedAt)
}

export async function putCogpackInstall(row: CogpackInstallRow): Promise<void> {
  await getDb().cogpackInstalls.put(row)
}
