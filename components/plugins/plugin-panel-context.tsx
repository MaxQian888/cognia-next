"use client"

// Lightweight Context wrapper for the /plugins panel. Mirrors `skill-panel-
// context.tsx` — exposes layout-affecting flags (embedded mode, optional
// className) without coupling them to the Zustand store. Most state lives
// in `usePluginsStore`; this Context only carries presentation hints.

import { createContext, useContext, type ReactNode } from "react"

export interface PluginPanelContextValue {
  /** Optional class applied to the root container. */
  className?: string
  /** True when the panel is embedded inside another shell (e.g., a Sheet). */
  embedded?: boolean
}

const PluginPanelContext = createContext<PluginPanelContextValue>({})

export function PluginPanelProvider({
  value,
  children,
}: {
  value: PluginPanelContextValue
  children: ReactNode
}) {
  return <PluginPanelContext.Provider value={value}>{children}</PluginPanelContext.Provider>
}

export function usePluginPanel(): PluginPanelContextValue {
  return useContext(PluginPanelContext)
}
