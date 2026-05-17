"use client"

/**
 * Editor store context — lets deeply-nested children grab the per-workflow
 * Zustand `EditorStore` without prop-drilling through React Flow's internal
 * node-type adapter or every form component.
 *
 * Default value is `null` (provider not mounted). Consumers must handle that
 * case — typically by gracefully degrading (no live subscription) so unit
 * tests that mount a node in isolation still render.
 *
 * Mirrors the pattern at
 * `components/workflow/editor/inspector/forms/shared/inspector-context.tsx`,
 * which scopes the same idea to a single `currentNodeId`.
 */

import { createContext, useContext, type ReactNode } from "react"
import type { EditorStore } from "@/lib/workflow/editor/store"

const EditorStoreContext = createContext<EditorStore | null>(null)

export function EditorStoreProvider({
  store,
  children,
}: {
  store: EditorStore
  children: ReactNode
}) {
  return <EditorStoreContext.Provider value={store}>{children}</EditorStoreContext.Provider>
}

export function useEditorStoreOrNull(): EditorStore | null {
  return useContext(EditorStoreContext)
}

/**
 * Throws when the context is missing. Use this in components that have no
 * meaningful fallback behaviour without the store.
 */
export function useEditorStore(): EditorStore {
  const store = useContext(EditorStoreContext)
  if (!store) {
    throw new Error("useEditorStore must be used inside <EditorStoreProvider>")
  }
  return store
}
