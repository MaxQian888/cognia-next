"use client"

// React-context plumbing for `DataAdapter`. Components consume data through
// the convenience hooks (`useCharacters()` etc.) so call sites don't need to
// know about the adapter object — they read like the original `useLiveQuery`
// usage but go through whatever provider is mounted at the root.
//
// PC desktop mounts `<DataAdapterProvider adapter={dexieAdapter}>` in
// `app/layout.tsx`. The mobile PWA (M4+) will mount the same provider with a
// WS-backed adapter instead.

import { createContext, useContext, type ReactNode } from "react"
import type { DataAdapter, SessionPatch } from "./types"

const DataAdapterContext = createContext<DataAdapter | null>(null)

interface ProviderProps {
  adapter: DataAdapter
  children: ReactNode
}

export function DataAdapterProvider({ adapter, children }: ProviderProps) {
  return <DataAdapterContext.Provider value={adapter}>{children}</DataAdapterContext.Provider>
}

/** Returns the adapter mounted by the nearest `DataAdapterProvider`. Throws
 * with a helpful message if no provider is in the tree — callers should never
 * have to handle that case in production. */
export function useDataAdapter(): DataAdapter {
  const adapter = useContext(DataAdapterContext)
  if (!adapter) {
    throw new Error(
      "useDataAdapter() called outside of <DataAdapterProvider>. " +
        "Mount it once near the root of your app (see app/layout.tsx)."
    )
  }
  return adapter
}

// Convenience hooks — thin wrappers that just dispatch to the active adapter.
// These are the names every chat component imports; the adapter object is an
// implementation detail consumers don't reach for directly.

export function useCharacters() {
  return useDataAdapter().useCharacters()
}

export function useCharacter(id: string | null | undefined) {
  return useDataAdapter().useCharacter(id)
}

export function useSkillsByIds(ids: readonly string[] | null | undefined) {
  return useDataAdapter().useSkillsByIds(ids)
}

export function usePresets() {
  return useDataAdapter().usePresets()
}

export function useClearMessages() {
  const adapter = useDataAdapter()
  return (sessionId: string) => adapter.clearMessages(sessionId)
}

export function useUpdateSession() {
  const adapter = useDataAdapter()
  return (id: string, patch: SessionPatch) => adapter.updateSession(id, patch)
}

export function useRecordPresetUsage() {
  const adapter = useDataAdapter()
  return (id: string) => adapter.recordPresetUsage(id)
}

export function useTrustWorkspace() {
  const adapter = useDataAdapter()
  return (path: string, note?: string) => adapter.trustWorkspace(path, note)
}
