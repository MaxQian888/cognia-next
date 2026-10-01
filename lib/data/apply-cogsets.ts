/**
 * Restore cogsets, cogpack imports and the host's cogset state (ADR-0209).
 *
 * Runs inside `applyBackupPackage`'s transaction, after the plugin rows, so
 * `pluginIdMap` already says where each imported plugin landed. Built-in
 * plugins are never imported (they ship with the app), so an id with no entry
 * in the map is kept as it is.
 *
 * What does not travel: `lastApplied` on a cogset and `appliedCogsetId` /
 * `pending` on the state describe what happened on the exporting host. The
 * next reconciliation on this host writes its own.
 */

import type { CogniaDB } from "@/lib/db/schema"
import {
  COGSET_STATE_ID,
  type CogpackInstallRow,
  type CogsetRow,
  type CogsetStateRow,
} from "@/types/plugin/plugin-cogset"

import type { ImportOptions, ImportSummary } from "./types"

export interface ApplyCogsetBackupArgs {
  db: CogniaDB
  cogsets: unknown[] | undefined
  cogpackInstalls: unknown[] | undefined
  cogsetState: unknown[] | undefined
  /** Old plugin id → id it was imported under. */
  pluginIdMap: ReadonlyMap<string, string>
  opts: Pick<ImportOptions, "mergeStrategy">
  summary: ImportSummary
  newId: (prefix: string) => string
}

function count(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1
}

export async function applyCogsetBackup(args: ApplyCogsetBackupArgs): Promise<void> {
  const { db, pluginIdMap, opts, summary } = args
  const remapPlugin = (id: string) => pluginIdMap.get(id) ?? id
  const cogsetIdMap = new Map<string, string>()

  for (const raw of (args.cogsets ?? []) as CogsetRow[]) {
    const { lastApplied: _lastApplied, ...portable } = raw
    const row: CogsetRow = {
      ...portable,
      members: raw.members.map((member) => ({ ...member, pluginId: remapPlugin(member.pluginId) })),
    }
    const existing = await db.pluginCogsets.get(row.id)
    if (!existing) {
      await db.pluginCogsets.put(row)
      count(summary.added, "pluginCogsets")
      cogsetIdMap.set(raw.id, row.id)
      continue
    }
    switch (opts.mergeStrategy) {
      case "skip":
        count(summary.skipped, "pluginCogsets")
        cogsetIdMap.set(raw.id, existing.id)
        break
      case "overwrite":
        // Keep this host's record of the last activation; it is about this host.
        await db.pluginCogsets.put({
          ...row,
          ...(existing.lastApplied ? { lastApplied: existing.lastApplied } : {}),
        })
        count(summary.overwritten, "pluginCogsets")
        cogsetIdMap.set(raw.id, row.id)
        break
      case "duplicate": {
        const copy: CogsetRow = { ...row, id: args.newId("cogset") }
        await db.pluginCogsets.put(copy)
        count(summary.added, "pluginCogsets")
        cogsetIdMap.set(raw.id, copy.id)
        break
      }
    }
  }
  const remapCogset = (id: string) => cogsetIdMap.get(id) ?? id

  for (const raw of (args.cogpackInstalls ?? []) as CogpackInstallRow[]) {
    const row: CogpackInstallRow = { ...raw, cogsetId: remapCogset(raw.cogsetId) }
    const existing = await db.cogpackInstalls.get(row.id)
    if (!existing) {
      await db.cogpackInstalls.put(row)
      count(summary.added, "cogpackInstalls")
      continue
    }
    switch (opts.mergeStrategy) {
      case "skip":
        count(summary.skipped, "cogpackInstalls")
        break
      case "overwrite":
        await db.cogpackInstalls.put(row)
        count(summary.overwritten, "cogpackInstalls")
        break
      case "duplicate":
        await db.cogpackInstalls.put({ ...row, id: args.newId("cogpack") })
        count(summary.added, "cogpackInstalls")
        break
    }
  }
  // A cogset that came from a duplicated import must point at the copy.
  for (const [oldId, newId] of cogsetIdMap) {
    if (oldId === newId) continue
    const copy = await db.pluginCogsets.get(newId)
    if (copy?.source.kind === "cogpack") {
      const install = await db.cogpackInstalls.where("cogsetId").equals(newId).first()
      if (install && install.id !== copy.source.installId) {
        await db.pluginCogsets.put({ ...copy, source: { ...copy.source, installId: install.id } })
      }
    }
  }

  const incomingState = ((args.cogsetState ?? []) as CogsetStateRow[]).find(
    (row) => row?.id === COGSET_STATE_ID
  )
  if (incomingState) {
    const existing = await db.pluginCogsetState.get(COGSET_STATE_ID)
    if (existing && opts.mergeStrategy === "skip") {
      count(summary.skipped, "pluginCogsetState")
      return
    }
    const globalCogsetId = incomingState.globalCogsetId
      ? remapCogset(incomingState.globalCogsetId)
      : undefined
    const globalExists = globalCogsetId ? !!(await db.pluginCogsets.get(globalCogsetId)) : false
    const next: CogsetStateRow = {
      // This host's runtime facts stay; only the choices travel.
      ...(existing ?? { id: COGSET_STATE_ID, alwaysOn: [], updatedAt: Date.now() }),
      alwaysOn: [...new Set(incomingState.alwaysOn.map(remapPlugin))].sort(),
      updatedAt: Date.now(),
    }
    if (globalExists && globalCogsetId) next.globalCogsetId = globalCogsetId
    else delete next.globalCogsetId
    if (
      incomingState.defaultBootstrappedAt !== undefined &&
      next.defaultBootstrappedAt === undefined
    )
      next.defaultBootstrappedAt = incomingState.defaultBootstrappedAt
    await db.pluginCogsetState.put(next)
    count(existing ? summary.overwritten : summary.added, "pluginCogsetState")
  }
}

/** The state row as it is exported: choices only, never this host's runtime facts. */
export function portableCogsetState(state: CogsetStateRow | undefined): CogsetStateRow[] {
  if (!state) return []
  return [
    {
      id: COGSET_STATE_ID,
      alwaysOn: [...state.alwaysOn],
      ...(state.globalCogsetId ? { globalCogsetId: state.globalCogsetId } : {}),
      ...(state.defaultBootstrappedAt !== undefined
        ? { defaultBootstrappedAt: state.defaultBootstrappedAt }
        : {}),
      updatedAt: state.updatedAt,
    },
  ]
}

/** A cogset as it is exported: without this host's last activation result. */
export function portableCogset(row: CogsetRow): CogsetRow {
  const { lastApplied: _lastApplied, ...portable } = row
  return portable
}
