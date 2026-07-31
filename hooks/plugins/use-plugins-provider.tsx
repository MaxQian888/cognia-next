"use client"

// Single shared live-query for the /plugins panel. Mount once at the panel
// root; every `usePlugins()` under it reads this view instead of opening
// its own Dexie subscription + rebuilding the same aggregation (see the
// context note in use-plugins.ts).

import { useDeferredValue, useMemo, type ReactNode } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { listPlugins } from "@/lib/db/plugins"
import { usePluginsStore } from "@/stores/plugins"
import { PluginsViewContext, buildView } from "./use-plugins"

export function PluginsViewProvider({ children }: { children: ReactNode }) {
  const rows = useLiveQuery(() => listPlugins(), [])
  const filters = usePluginsStore((s) => s.filters)
  // Keystrokes update the search input at normal priority; the O(n)
  // re-filter of every consumer happens at deferred priority.
  const deferredFilters = useDeferredValue(filters)
  const view = useMemo(() => buildView(rows, deferredFilters), [rows, deferredFilters])
  return <PluginsViewContext.Provider value={view}>{children}</PluginsViewContext.Provider>
}
