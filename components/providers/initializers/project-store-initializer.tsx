"use client"

import { useEffect, useSyncExternalStore } from "react"
import Dexie from "dexie"

import {
  getRuntimeTargetScopeKey,
  subscribeRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"

import { getAllProjects } from "@/lib/db/projects"
import { useProjectStore } from "@/stores/project/project-store"
import { loggers } from "@cognia/logging"

const log = loggers.shell

/**
 * Boot-time initializer for the workspace/project model. Hydrates
 * `useProjectStore` from Dexie (`projects` table + the active-workspace
 * pointer on the settings singleton) on first paint, so the workspace
 * switcher and the cwd resolution chain see persisted workspaces immediately.
 *
 * `load()` is idempotent and swallows its own errors (web/test without
 * indexedDB just stays in-memory). Following the `LocalCharacterPackInitializer`
 * shape so the `app/layout.tsx` entry stays homogeneous.
 *
 * It then keeps watching the table, because `load()` returns early once it has
 * run and `projects` is now companion-synced: on a paired phone the Host's
 * workspaces arrive after boot, and without this subscription they sat in
 * Dexie invisible to the switcher until the app was restarted. Watching the
 * table rather than the sync run also covers every other writer.
 */
export function ProjectStoreInitializer() {
  const scopeKey = useSyncExternalStore(
    subscribeRuntimeTargetContext,
    getRuntimeTargetScopeKey,
    getRuntimeTargetScopeKey
  )

  useEffect(() => {
    let cancelled = false
    const isCurrent = () => !cancelled && getRuntimeTargetScopeKey() === scopeKey

    let subscription: { unsubscribe: () => void } | null = null
    void useProjectStore
      .getState()
      .load()
      .then(() => {
        if (!isCurrent()) return
        // `Dexie.liveQuery`, not the named `liveQuery` export: the latter is
        // undefined under Jest's module interop.
        subscription = Dexie.liveQuery(() => getAllProjects()).subscribe({
          next: (projects) => {
            if (isCurrent()) useProjectStore.getState().adoptPersistedProjects(projects)
          },
          error: (err: unknown) => log.warn("project-store: live query failed", { err }),
        })
      })
      .catch((err) => log.warn("project-store: boot load threw", { err }))

    return () => {
      cancelled = true
      subscription?.unsubscribe()
    }
  }, [scopeKey])

  return null
}

export default ProjectStoreInitializer
