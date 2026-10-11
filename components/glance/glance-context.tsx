"use client"

/**
 * What every glance module reads (ADR-0225 §9): the snapshot, where it is
 * rendered, and how to ask the main window for something.
 *
 * Modules never import a store, a Dexie table or a Tauri API. They read this
 * context and call `send`, which is what lets the same module render in the
 * desktop tray panel window today and on the phone in phase 3.
 */

import { createContext, useContext } from "react"

import type { GlanceRequestBody } from "@/lib/glance/requests"
import type { GlanceSnapshotV1 } from "@/lib/glance/snapshot"
import type { GlanceWidthStep } from "@/types/glance/layout"

export type GlancePlatform = "desktop" | "mobile"

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
}

const GlanceContext = createContext<GlanceContextValue | null>(null)

export const GlanceProvider = GlanceContext.Provider

export function useGlance(): GlanceContextValue {
  const value = useContext(GlanceContext)
  if (!value) throw new Error("useGlance must be used inside a GlanceProvider")
  return value
}
