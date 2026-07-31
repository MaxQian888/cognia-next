/**
 * CRUD for the `toolRoutes` Dexie table (schema v76) — persisted semantic
 * routes for tool/plugin routing. See `types/routing/tool-route.ts`.
 */

import { getDb } from "./schema"
import type { ToolRouteRecord } from "@/types/routing/tool-route"

export function makeToolRouteId(
  source: ToolRouteRecord["source"],
  kind: ToolRouteRecord["kind"],
  refId: string
): string {
  return `${source}:${kind}:${refId}`
}

export async function upsertToolRoute(record: ToolRouteRecord): Promise<void> {
  await getDb().toolRoutes.put({ ...record, updatedAt: Date.now() })
}

export async function getToolRoute(id: string): Promise<ToolRouteRecord | undefined> {
  return getDb().toolRoutes.get(id)
}

export async function listToolRoutes(): Promise<ToolRouteRecord[]> {
  return getDb().toolRoutes.toArray()
}

/** Enabled routes only — what the matcher consumes. */
export async function listEnabledToolRoutes(): Promise<ToolRouteRecord[]> {
  const all = await getDb().toolRoutes.toArray()
  return all.filter((route) => route.enabled)
}

export async function deleteToolRoute(id: string): Promise<void> {
  await getDb().toolRoutes.delete(id)
}

/** Drop every manifest-sourced route a plugin contributed (disable path). */
export async function deleteToolRoutesByPlugin(pluginId: string): Promise<number> {
  const all = await getDb().toolRoutes.toArray()
  const doomed = all.filter((route) => route.source === "manifest" && route.pluginId === pluginId)
  await getDb().toolRoutes.bulkDelete(doomed.map((route) => route.id))
  return doomed.length
}

/**
 * Persist freshly computed utterance vectors onto a route (cache write-back;
 * best-effort — failures must never break a send).
 */
export async function cacheToolRouteEmbeddings(
  id: string,
  embeddings: number[][],
  embeddingModel: string
): Promise<void> {
  await getDb().toolRoutes.update(id, { embeddings, embeddingModel, updatedAt: Date.now() })
}
