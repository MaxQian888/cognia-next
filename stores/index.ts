/**
 * Top-level stores barrel — exposes the shape Cognia-ported code expects
 * (`useArtifactStore`, `useChatStore`, `useSettingsStore`, `useUIStore`,
 * `useSessionStore`, `useNativeStore`).
 *
 * cognia-next does not have a dedicated session store; chat sessions live
 * across `useChatStore` (current state) and `useSessions()` (Dexie-backed
 * CRUD). To satisfy ported canvas code that calls
 * `useSessionStore((s) => s.getActiveSession())`, we synthesise a tiny
 * adapter Zustand store that returns a session-shaped object derived from
 * the chat store. Likewise `useNativeStore` is a one-field store
 * (`isDesktop`) used only for runtime branching.
 */

"use client"

import { create } from "zustand"
import { useArtifactStore } from "./artifact"
import { useSettingsStore } from "./settings"
import { isTauri } from "@/lib/tauri"

export { useArtifactStore } from "./artifact"
export { useChatStore } from "./chat"
export { useSettingsStore } from "./settings"
export { useUIStore } from "./ui"
export {
  useCanvasSettingsStore,
  useChunkedDocumentStore,
  useCommentStore,
  useKeybindingStore,
} from "./canvas"

/**
 * Synthetic session-store-like surface used by ported canvas hooks.
 * The fields `getActiveSession`, `provider`, `defaultProvider`, etc.
 * map onto cognia-next's chat / settings stores.
 */
export interface SessionStoreLike {
  getActiveSession: () => {
    id: string | null
    provider?: string
    model?: string
    apiKey?: string
    workingDir?: string
    title?: string
  } | null
}

export const useSessionStore = create<SessionStoreLike>(() => ({
  getActiveSession: () => {
    const settings = useSettingsStore.getState().settings
    // cognia-next exposes the active session via the chat store's
    // `currentSessionId`, but the more reliable path is the artifact
    // store's `currentSessionId` (canvas tracks it explicitly). Fall
    // back to `null` when neither is present.
    const artifactSessionId =
      (useArtifactStore.getState() as unknown as { currentSessionId?: string }).currentSessionId ??
      null
    if (!artifactSessionId) return null
    return {
      id: artifactSessionId,
      provider: "anthropic",
      model: settings?.defaultModel,
      apiKey: settings?.apiKey,
    }
  },
}))

/** Native-runtime adapter — mirrors Cognia's `useNativeStore.isDesktop`. */
export interface NativeStoreLike {
  isDesktop: boolean
}

export const useNativeStore = create<NativeStoreLike>(() => ({
  isDesktop: isTauri(),
}))
