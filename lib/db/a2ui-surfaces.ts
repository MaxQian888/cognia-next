// CRUD for the `a2uiSurfaces` Dexie table (v13). Runtime surfaces with
// `type === "panel"` or `type === "fullscreen"` persist here so they
// survive a reload. Inline surfaces live and die with their chat message.

import { getDb } from "./schema"
import type { A2UISurfaceRow } from "./a2ui-types"

export async function listSurfaces(): Promise<A2UISurfaceRow[]> {
  return getDb().a2uiSurfaces.orderBy("updatedAt").reverse().toArray()
}

export async function getSurface(id: string): Promise<A2UISurfaceRow | undefined> {
  return getDb().a2uiSurfaces.get(id)
}

export async function listSurfacesForSession(sessionId: string): Promise<A2UISurfaceRow[]> {
  return getDb().a2uiSurfaces.where("sessionId").equals(sessionId).toArray()
}

export async function upsertSurface(row: A2UISurfaceRow): Promise<void> {
  // Inline surfaces are explicitly excluded from persistence.
  if (row.type === "inline") return
  await getDb().a2uiSurfaces.put(row)
}

export async function deleteSurface(id: string): Promise<void> {
  await getDb().a2uiSurfaces.delete(id)
}

export async function deleteAllSurfaces(): Promise<number> {
  const count = await getDb().a2uiSurfaces.count()
  await getDb().a2uiSurfaces.clear()
  return count
}
