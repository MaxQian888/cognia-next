/**
 * useA2UISave
 *
 * Persist a workspace surface as a durable saved app. Component/data-model
 * edits already auto-persist to the zustand localStorage store, but that store
 * is LRU-capped and not included in data backups. An explicit Save commits the
 * current tree + data model to the Dexie `a2uiApps` table (unbounded, backed
 * up) and bumps the app instance's `lastModified` so it surfaces as recently
 * edited. Returns false when the surface or its instance can't be resolved.
 */

import { useCallback } from "react"
import { useA2UIStore } from "@/stores/a2ui"
import { getAppInstancesCache, saveAppInstances } from "./app-builder/persistence"
import { upsertApp } from "@/lib/db/a2ui-apps"
import type { A2UIAppRow } from "@/lib/db/a2ui-types"

export function useA2UISave(surfaceId: string) {
  return useCallback(async (): Promise<boolean> => {
    const surface = useA2UIStore.getState().getSurface(surfaceId)
    const instances = getAppInstancesCache()
    const instance = instances.get(surfaceId)
    if (!surface || !instance) return false

    const now = Date.now()
    instance.lastModified = now
    saveAppInstances(instances)

    const row: A2UIAppRow = {
      ...instance,
      components: surface.components,
      dataModel: surface.dataModel,
      rootId: surface.rootId,
      catalogId: surface.catalogId,
      widget: surface.widget,
      lastModified: now,
      updatedAt: now,
    }
    await upsertApp(row)
    return true
  }, [surfaceId])
}
