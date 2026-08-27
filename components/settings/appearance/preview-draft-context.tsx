"use client"

// Carries the custom-theme editor's *unsaved* draft up to the single
// `AppearancePreview` in the Appearance section's detail header, so one preview
// serves every panel instead of each editor shipping its own.
//
// Why an external store rather than `useState` + context:
//
//   `react-hooks/set-state-in-effect` is enforced under `components/settings/**`
//   (eslint.config.mjs relaxes it only for `components/ai-elements/**` and
//   `components/ui/**`), so the obvious `useEffect(() => setColors(draft))` in
//   the provider is a lint error. Pushing from event handlers instead doesn't
//   work either: `custom-theme-tab.tsx` reconciles the draft *during render*
//   when the saved-theme list changes, and a parent setState from a child's
//   render phase makes React throw ("Cannot update a component while rendering
//   a different component"). An external-store write is neither a `useState`
//   setter nor a render-phase React update, so it sidesteps both — and it is
//   already this repo's idiom (see `plugin-extension-slot.tsx`).
//
// The store is instance-scoped (created by the section, passed through
// context), not a module singleton, so tests can't leak state into each other.

import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react"
import type { ResolvedThemeColors } from "@/types/plugin/plugin"

export interface AppearanceDraftSnapshot {
  /**
   * A *complete* palette. `AppearancePreview` writes these as scoped CSS
   * variables, and anything left unset would cascade from `<html>` — a dark
   * draft under a light app would render half-light. Publishers materialise
   * their sparse draft against the variant fallback first (`fillTokens`).
   */
  colors: ResolvedThemeColors
  isDark: boolean
}

export interface PreviewDraftStore {
  publish: (next: AppearanceDraftSnapshot | null) => void
  subscribe: (onChange: () => void) => () => void
  getSnapshot: () => AppearanceDraftSnapshot | null
  getServerSnapshot: () => null
}

export function createPreviewDraftStore(): PreviewDraftStore {
  // Held in a closure and returned by identity, so `useSyncExternalStore`'s
  // "snapshot should be cached" check passes.
  let snapshot: AppearanceDraftSnapshot | null = null
  const listeners = new Set<() => void>()
  return {
    publish(next) {
      if (next === snapshot) return
      snapshot = next
      for (const listener of listeners) listener()
    },
    subscribe(onChange) {
      listeners.add(onChange)
      return () => {
        listeners.delete(onChange)
      }
    },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => null,
  }
}

// Inert default: an editor rendered outside the section (Storybook, its own
// unit test) publishes into the void rather than needing a provider or a guard.
const INERT_STORE: PreviewDraftStore = {
  publish: () => {},
  subscribe: () => () => {},
  getSnapshot: () => null,
  getServerSnapshot: () => null,
}

const PreviewDraftContext = createContext<PreviewDraftStore>(INERT_STORE)

export function AppearancePreviewDraftProvider({
  store,
  children,
}: {
  store: PreviewDraftStore
  children: ReactNode
}) {
  return <PreviewDraftContext.Provider value={store}>{children}</PreviewDraftContext.Provider>
}

/** Writer side. Returns the stable `publish` — safe as an effect dependency. */
export function usePreviewDraftPublisher(): PreviewDraftStore["publish"] {
  return useContext(PreviewDraftContext).publish
}

/** Reader side. Re-renders only this subscriber when the draft changes. */
export function usePreviewDraft(): AppearanceDraftSnapshot | null {
  const store = useContext(PreviewDraftContext)
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot)
}
