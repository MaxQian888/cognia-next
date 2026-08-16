"use client"

/**
 * Title-bar outlets — how the chat workspace's column headers move up into the
 * shell's single 40px top bar.
 *
 * Before this the desktop shell stacked two rows of chrome (the 32px title bar
 * plus a 44 / 36 / 40px header per column) and the web shell had the three
 * stepped headers and no bar at all. Now `TitleBar` (`components/desktop/`)
 * renders one bar on both platforms and exposes three portal outlets — one per
 * structural zone — and each column's header renders its content *into* the
 * outlet above it instead of drawing its own row:
 *
 *   ┌────────────┬────────────────────────────┬──────────────┐  ← TitleBar, 40px
 *   │ start      │ center                     │ end          │
 *   │ (rail hdr) │ (chat header · nav arrows) │ (dock hdr)   │
 *   ├────────────┼────────────────────────────┼──────────────┤
 *   │ Channel-   │ ChatPaneGroup              │ Artifact     │
 *   │ List       │                            │ dock         │
 *
 * Alignment is the bar's job: it sizes the start and end outlets to the
 * measured widths of the columns beneath them (`useShellColumnsStore`), so the
 * center is whatever is left — exactly the chat column.
 *
 * Three pieces, kept deliberately small:
 *
 * - `TitleBarOutletsProvider` — mounted once by the desktop app shell. Holds
 *   the outlet elements the bar registers and a per-zone count of projectors.
 * - `TitleBarProjectionScope` — opt-in for a subtree. Only the chat workspace
 *   turns it on: a `ChatHeader` inside the inbox detail, a Canvas sidechat, or
 *   the mobile Sheet must keep drawing its own header, and a component cannot
 *   tell where it is mounted on its own.
 * - `useTitleBarProjection(zone)` — what a header calls. Returns the outlet to
 *   `createPortal` into, or `null` (draw inline) when there is no bar, no
 *   provider, or no enabling scope. While it returns an element it counts
 *   itself as projecting, which the bar reads to hide the zone's own default
 *   segments and size the outlet.
 *
 * Nothing here is persisted or platform-gated; the mobile shell never mounts
 * the provider, so every hook degrades to "draw inline" there.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"

export type TitleBarZone = "start" | "center" | "end"

export const TITLE_BAR_ZONES: readonly TitleBarZone[] = ["start", "center", "end"]

type OutletElements = Record<TitleBarZone, HTMLElement | null>
type ProjectionCounts = Record<TitleBarZone, number>

interface TitleBarOutletsContextValue {
  outlets: OutletElements
  setOutlet: (zone: TitleBarZone, el: HTMLElement | null) => void
  projections: ProjectionCounts
  /** Count one projector into `zone`; returns the matching un-count. */
  registerProjection: (zone: TitleBarZone) => () => void
}

const EMPTY_OUTLETS: OutletElements = { start: null, center: null, end: null }
const ZERO_PROJECTIONS: ProjectionCounts = { start: 0, center: 0, end: 0 }

const TitleBarOutletsContext = createContext<TitleBarOutletsContextValue | null>(null)
const TitleBarProjectionScopeContext = createContext(false)

export function TitleBarOutletsProvider({ children }: { children: ReactNode }) {
  const [outlets, setOutlets] = useState<OutletElements>(EMPTY_OUTLETS)
  const [projections, setProjections] = useState<ProjectionCounts>(ZERO_PROJECTIONS)

  const setOutlet = useCallback((zone: TitleBarZone, el: HTMLElement | null) => {
    setOutlets((prev) => (prev[zone] === el ? prev : { ...prev, [zone]: el }))
  }, [])

  const registerProjection = useCallback((zone: TitleBarZone) => {
    setProjections((prev) => ({ ...prev, [zone]: prev[zone] + 1 }))
    return () => {
      setProjections((prev) => ({ ...prev, [zone]: Math.max(0, prev[zone] - 1) }))
    }
  }, [])

  const value = useMemo<TitleBarOutletsContextValue>(
    () => ({ outlets, setOutlet, projections, registerProjection }),
    [outlets, setOutlet, projections, registerProjection]
  )
  return <TitleBarOutletsContext.Provider value={value}>{children}</TitleBarOutletsContext.Provider>
}

/**
 * Turn projection on (or explicitly off) for everything underneath. Nested
 * scopes override outward ones, which is how the conversation rail's mobile
 * Sheet keeps its inline header inside a workspace that projects.
 */
export function TitleBarProjectionScope({
  enabled,
  children,
}: {
  enabled: boolean
  children: ReactNode
}) {
  return (
    <TitleBarProjectionScopeContext.Provider value={enabled}>
      {children}
    </TitleBarProjectionScopeContext.Provider>
  )
}

/**
 * For the bar: a callback ref that registers the zone's outlet element.
 * Stable per zone so React does not re-run it every render.
 */
export function useTitleBarOutletRef(zone: TitleBarZone): (el: HTMLElement | null) => void {
  const ctx = useContext(TitleBarOutletsContext)
  const setOutlet = ctx?.setOutlet
  return useCallback((el: HTMLElement | null) => setOutlet?.(zone, el), [setOutlet, zone])
}

/** For the bar: which zones currently have at least one projector. */
export function useTitleBarProjectionState(): Record<TitleBarZone, boolean> {
  const ctx = useContext(TitleBarOutletsContext)
  const counts = ctx?.projections ?? ZERO_PROJECTIONS
  return useMemo(
    () => ({ start: counts.start > 0, center: counts.center > 0, end: counts.end > 0 }),
    [counts.start, counts.center, counts.end]
  )
}

/**
 * For a column header: the outlet to portal into, or `null` to draw inline.
 * Pass `active: false` to stand down without unmounting — the conversation
 * rail does this while collapsed, so an invisible column does not leave its
 * header stranded in the bar.
 */
export function useTitleBarProjection(
  zone: TitleBarZone,
  { active = true }: { active?: boolean } = {}
): HTMLElement | null {
  const ctx = useContext(TitleBarOutletsContext)
  const inScope = useContext(TitleBarProjectionScopeContext)
  const outlet = ctx && inScope && active ? ctx.outlets[zone] : null
  const registerProjection = ctx?.registerProjection

  useEffect(() => {
    if (!outlet || !registerProjection) return
    return registerProjection(zone)
  }, [outlet, registerProjection, zone])

  return outlet
}
