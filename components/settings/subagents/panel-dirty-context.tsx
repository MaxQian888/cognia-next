"use client"

/**
 * Lets the section know whether the panel currently on screen has unsaved
 * edits, so it can dot the nav row and intercept a navigation that would throw
 * those edits away.
 *
 * A single boolean rather than a registry keyed by panel: `PanelTransition`
 * mounts exactly one panel at a time, so "some panel is dirty" and "the active
 * panel is dirty" are the same statement. A map would imply we could track
 * unsaved work in panels that are not mounted, which we cannot — their state
 * goes with them.
 */

import { createContext, useContext, useEffect, useMemo, useState } from "react"

interface PanelDirtyValue {
  dirty: boolean
  setDirty: (dirty: boolean) => void
}

const PanelDirtyContext = createContext<PanelDirtyValue>({
  dirty: false,
  setDirty: () => {},
})

export function PanelDirtyProvider({ children }: { children: React.ReactNode }) {
  const [dirty, setDirty] = useState(false)
  const value = useMemo(() => ({ dirty, setDirty }), [dirty])
  return <PanelDirtyContext.Provider value={value}>{children}</PanelDirtyContext.Provider>
}

/** Read the active panel's dirty flag (section side). */
export function usePanelDirty(): boolean {
  return useContext(PanelDirtyContext).dirty
}

/**
 * Publish this panel's dirty flag (panel side). Clears on unmount so a panel
 * that leaves the screen cannot keep the section blocked.
 */
export function useReportPanelDirty(dirty: boolean): void {
  const { setDirty } = useContext(PanelDirtyContext)
  useEffect(() => {
    setDirty(dirty)
    return () => setDirty(false)
  }, [dirty, setDirty])
}
