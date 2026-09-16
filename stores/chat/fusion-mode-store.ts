/**
 * The Router + Fusion mode the composer asks for, per conversation
 * (ADR-0188 B3, D23).
 *
 * `auto` — the default, and what an absent entry means — lets the router
 * decide (a direct turn unless an approved rule row picks a cascade or panel).
 * `direct` pins the ordinary streaming turn; `cascade` and `panel` ask for a
 * verified run explicitly.
 *
 * Read only while Router + Fusion chat is on: with it off the send path never
 * asks, so a stored choice changes nothing (D37). The picker is hidden then.
 * A per-device convenience, like the reply target, kept in local storage.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"

import { persistLocalStorage } from "@/stores/persist-storage"

export const CHAT_FUSION_MODES = ["auto", "direct", "cascade", "panel"] as const
export type ChatFusionMode = (typeof CHAT_FUSION_MODES)[number]

/** Choices remembered at most; the oldest are dropped first. */
export const MAX_REMEMBERED_FUSION_MODES = 200

export interface ChatFusionModeState {
  /** Per session, a choice other than `auto`, in the order they were made. */
  modes: Record<string, Exclude<ChatFusionMode, "auto">>
  setMode: (sessionId: string, mode: ChatFusionMode) => void
}

export function isChatFusionMode(value: unknown): value is ChatFusionMode {
  return (CHAT_FUSION_MODES as readonly unknown[]).includes(value)
}

export const useChatFusionModeStore = create<ChatFusionModeState>()(
  persist(
    (set) => ({
      modes: {},
      setMode: (sessionId, mode) =>
        set((state) => {
          if (!sessionId || !isChatFusionMode(mode)) return state
          const current = state.modes[sessionId]
          if ((current ?? "auto") === mode) return state
          const modes = { ...state.modes }
          delete modes[sessionId]
          if (mode !== "auto") modes[sessionId] = mode
          const keys = Object.keys(modes)
          for (const stale of keys.slice(
            0,
            Math.max(0, keys.length - MAX_REMEMBERED_FUSION_MODES)
          )) {
            delete modes[stale]
          }
          return { modes }
        }),
    }),
    {
      name: "cognia-next.chat-fusion-mode",
      version: 1,
      storage: persistLocalStorage(),
      partialize: (state) => ({ modes: state.modes }),
      merge: (persisted, current) => {
        const raw = (persisted as { modes?: unknown } | undefined)?.modes
        const modes: ChatFusionModeState["modes"] = {}
        if (raw && typeof raw === "object") {
          for (const [sessionId, mode] of Object.entries(raw as Record<string, unknown>)) {
            if (mode === "direct" || mode === "cascade" || mode === "panel") modes[sessionId] = mode
          }
        }
        return { ...current, modes }
      },
    }
  )
)

/** The mode the composer asks for in `sessionId`; `auto` when nothing was chosen. */
export function chatFusionModeOf(sessionId: string | null | undefined): ChatFusionMode {
  return (sessionId && useChatFusionModeStore.getState().modes[sessionId]) || "auto"
}

export function useChatFusionMode(sessionId: string | null | undefined): ChatFusionMode {
  return useChatFusionModeStore((state) => (sessionId && state.modes[sessionId]) || "auto")
}
