"use client"

/**
 * The phone's glance, mounted once by the mobile shell (ADR-0225 §9).
 *
 * Owns the one `useMobileGlance` instance the home screen and the Glance
 * drawer share, whether the drawer is open, whether the home screen is on
 * screen (the home registers itself while mounted), and the doors the
 * modules need from the shell: start a chat, search, resume a conversation,
 * and open the layout editor.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { useRouter } from "next/navigation"

import { useMobileGlance, type UseMobileGlanceResult } from "@/hooks/glance/use-mobile-glance"

export interface MobileGlanceShellActions {
  newChat: () => void
  search: () => void
  openSession: (sessionId: string) => void
  /** Open the layout editor sheet (modules, home pins, shortcuts). */
  editLayout: () => void
}

export interface MobileGlanceContextValue extends UseMobileGlanceResult {
  actions: MobileGlanceShellActions
  drawerOpen: boolean
  setDrawerOpen: (open: boolean) => void
  /** The home screen calls this while it is mounted. Returns the unregister. */
  registerHome: () => () => void
}

const MobileGlanceContext = createContext<MobileGlanceContextValue | null>(null)

export function useMobileGlanceContext(): MobileGlanceContextValue {
  const value = useContext(MobileGlanceContext)
  if (!value) throw new Error("useMobileGlanceContext must be used inside MobileGlanceProvider")
  return value
}

export interface MobileGlanceProviderProps {
  actions: MobileGlanceShellActions
  children: ReactNode
}

export function MobileGlanceProvider({ actions, children }: MobileGlanceProviderProps) {
  const router = useRouter()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [homeMounts, setHomeMounts] = useState(0)

  const registerHome = useCallback(() => {
    setHomeMounts((n) => n + 1)
    return () => setHomeMounts((n) => n - 1)
  }, [])

  const navigate = useCallback((href: string) => router.push(href), [router])
  const closeDrawer = useCallback(() => setDrawerOpen(false), [])
  const editShortcuts = useCallback(() => {
    setDrawerOpen(false)
    actions.editLayout()
  }, [actions])

  const glance = useMobileGlance({
    drawerOpen,
    homeVisible: homeMounts > 0,
    navigate,
    openSession: actions.openSession,
    editShortcuts,
    onRouted: closeDrawer,
  })

  const value = useMemo<MobileGlanceContextValue>(
    () => ({ ...glance, actions, drawerOpen, setDrawerOpen, registerHome }),
    [glance, actions, drawerOpen, registerHome]
  )

  return <MobileGlanceContext.Provider value={value}>{children}</MobileGlanceContext.Provider>
}

/** Mark the home screen as on screen for as long as the caller is mounted. */
export function useRegisterGlanceHome(): void {
  const { registerHome } = useMobileGlanceContext()
  useEffect(() => registerHome(), [registerHome])
}
