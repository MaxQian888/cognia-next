/**
 * A2UI App Builder - Persistence Layer
 * Handles localStorage read/write for app instances
 */

import { loggers } from "@/lib/logging"
import type { A2UIAppInstance } from "./types"

const log = loggers.app

// Local storage key for app instances
const APP_INSTANCES_KEY = "a2ui-app-instances"

/**
 * Load app instances from local storage
 */
export function loadAppInstances(): Map<string, A2UIAppInstance> {
  if (typeof window === "undefined") return new Map()

  try {
    const stored = localStorage.getItem(APP_INSTANCES_KEY)
    if (stored) {
      const parsed = JSON.parse(stored) as A2UIAppInstance[]
      return new Map(parsed.map((app) => [app.id, app]))
    }
  } catch (error) {
    log.error("A2UI AppBuilder: Failed to load app instances", error as Error)
  }
  return new Map()
}

/**
 * Save app instances to local storage
 */
export function saveAppInstances(instances: Map<string, A2UIAppInstance>): void {
  if (typeof window === "undefined") return

  try {
    const data = Array.from(instances.values())
    localStorage.setItem(APP_INSTANCES_KEY, JSON.stringify(data))
  } catch (error) {
    log.error("A2UI AppBuilder: Failed to save app instances", error as Error)
  }
}

// In-memory app instances cache
let appInstancesCache: Map<string, A2UIAppInstance> | null = null

export function getAppInstancesCache(): Map<string, A2UIAppInstance> {
  if (!appInstancesCache) {
    appInstancesCache = loadAppInstances()
  }
  return appInstancesCache
}
