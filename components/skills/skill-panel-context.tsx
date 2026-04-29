"use client"

// Lightweight provider that lets nested skill panel components reach for
// shared callbacks (open detail / open editor / etc.) without prop-drilling.
// Most state actually lives in `useSkillsStore`; this is just a tidy way to
// pass things like "the resolved className for the panel root".

import { createContext, useContext } from "react"

interface SkillPanelContextValue {
  className?: string
  /** When true, the panel is rendered inside a sheet/drawer (mobile). */
  embedded?: boolean
}

const SkillPanelContext = createContext<SkillPanelContextValue | null>(null)

export function SkillPanelProvider({
  children,
  className,
  embedded,
}: SkillPanelContextValue & { children: React.ReactNode }) {
  return (
    <SkillPanelContext.Provider value={{ className, embedded }}>
      {children}
    </SkillPanelContext.Provider>
  )
}

export function useSkillPanel(): SkillPanelContextValue {
  const ctx = useContext(SkillPanelContext)
  return ctx ?? {}
}
