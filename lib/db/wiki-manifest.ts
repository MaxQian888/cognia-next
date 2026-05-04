/**
 * CRUD layer for the `wikiManifest` Dexie table (v17).
 *
 * One row per scope. Stores the Merkle map (filePath → sha256 at last build)
 * plus aggregate metadata. The orchestrator reads this on every refresh to
 * decide which files have changed, then rewrites it on successful commit.
 *
 * Primary key is `scope` (no separate `id` field) because there can only ever
 * be one manifest per scope. The Dexie schema declares `&scope` as the
 * unique primary key.
 */

import type { WikiManifest, WikiScope } from "@/types/wiki"
import { getDb } from "./schema"

export async function getWikiManifest(scope: WikiScope): Promise<WikiManifest | undefined> {
  return getDb().wikiManifest.get(scope)
}

export async function upsertWikiManifest(manifest: WikiManifest): Promise<WikiManifest> {
  await getDb().wikiManifest.put(manifest)
  return manifest
}

export async function deleteWikiManifest(scope: WikiScope): Promise<void> {
  await getDb().wikiManifest.delete(scope)
}

export async function listAllWikiManifests(): Promise<WikiManifest[]> {
  return getDb().wikiManifest.toArray()
}

/**
 * Compute the file-level diff between an on-disk Merkle map and the manifest.
 * Returns three sets so the orchestrator can decide what to do per file:
 *   • `added`    — file exists on disk, not in manifest
 *   • `changed`  — file exists in both but sha differs (re-index)
 *   • `removed`  — file in manifest, missing from disk (delete article)
 *
 * This is a pure function; no Dexie reads. Caller passes the manifest row
 * (or `undefined` for a fresh scope).
 */
export function diffManifest(
  manifest: WikiManifest | undefined,
  current: Record<string, string>
): { added: string[]; changed: string[]; removed: string[]; unchanged: string[] } {
  const added: string[] = []
  const changed: string[] = []
  const removed: string[] = []
  const unchanged: string[] = []

  const previous = manifest?.fileHashes ?? {}
  const currentPaths = new Set(Object.keys(current))
  const previousPaths = new Set(Object.keys(previous))

  for (const path of currentPaths) {
    if (!previousPaths.has(path)) {
      added.push(path)
    } else if (previous[path] !== current[path]) {
      changed.push(path)
    } else {
      unchanged.push(path)
    }
  }
  for (const path of previousPaths) {
    if (!currentPaths.has(path)) {
      removed.push(path)
    }
  }

  return { added, changed, removed, unchanged }
}
