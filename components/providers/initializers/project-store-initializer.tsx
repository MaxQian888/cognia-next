"use client"

import { useEffect, useRef } from "react"

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
 */
export function ProjectStoreInitializer() {
  const hasInitialized = useRef(false)

  useEffect(() => {
    if (hasInitialized.current) return
    hasInitialized.current = true
    void useProjectStore
      .getState()
      .load()
      .catch((err) => log.warn("project-store: boot load threw", { err }))
  }, [])

  return null
}

export default ProjectStoreInitializer
