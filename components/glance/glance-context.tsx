"use client"

/**
 * What every glance module reads (ADR-0225 §9): the snapshot, where it is
 * rendered, and how to ask the main window for something.
 *
 * Modules never import a store, a Dexie table or a Tauri API. They read this
 * context and call `send`, which is what lets the same module render in the
 * desktop tray panel window and on a phone's home screen and Glance drawer.
 */

import { createContext, useContext } from "react"

import type { GlancePlatform } from "@/lib/glance/registry"
import type { GlanceModuleOrigin } from "@/lib/glance/remote/phone-view"
import type { GlanceRequestBody } from "@/lib/glance/requests"
import type { GlanceSnapshotV1 } from "@/lib/glance/snapshot"
import type { GlanceModuleId, GlanceWidthStep } from "@/types/glance/layout"

export type { GlancePlatform, GlanceModuleOrigin }

export interface GlanceContextValue {
  snapshot: GlanceSnapshotV1
  platform: GlancePlatform
  width: GlanceWidthStep
  /** Wall clock the consumer last ticked at, for relative labels. */
  now: number
  /**
   * Ask the main window. Resolves when the result arrives (or the consumer
   * gives up waiting): `null` on success, an `glance.errors.*` key otherwise.
   */
  send: (body: GlanceRequestBody) => Promise<string | null>
  /**
   * Route a click to an owner surface. The desktop panel closes itself after
   * sending; a phone drawer stays open. Same request vocabulary as `send`.
   */
  route: (body: GlanceRequestBody) => void
  /**
   * Where a module's data came from, when not from this device: a paired
   * phone labels the desktop's slices with the host's name and their age, and
   * says in place when the desktop cannot supply one (ADR-0225 §9). Absent or
   * null means this device's own data.
   */
  originOf?: (id: GlanceModuleId) => GlanceModuleOrigin | null
}

const GlanceContext = createContext<GlanceContextValue | null>(null)

export const GlanceProvider = GlanceContext.Provider

export function useGlance(): GlanceContextValue {
  const value = useContext(GlanceContext)
  if (!value) throw new Error("useGlance must be used inside a GlanceProvider")
  return value
}
