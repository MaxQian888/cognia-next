"use client"

/**
 * Roving focus for the expanded sidebar's rows.
 *
 * The sidebar stacks four independent row groups — the shell navigation
 * (`sidebar-nav-section.tsx`), the guild accordion above and below the
 * conversation list (`sidebar-guild-sections.tsx`), the create-team row, and
 * the footer (`sidebar-footer.tsx`). Left alone that is fifteen-plus tab stops
 * between the window chrome and the conversation you came for, and the arrow
 * keys do nothing on any of them — while the list *below* them binds arrows to
 * its own focus ring (`channel-list.tsx`), so ArrowDown on "Canvas" moved a
 * highlight the user could not see.
 *
 * So: one tab stop for the whole stack, arrows / Home / End move between rows,
 * and the keystroke stops there rather than reaching the list's handler. Order
 * is read from the DOM at keydown time, which is what makes it work across four
 * components that do not know about each other (and keeps working when the
 * accordion moves a section from above the list to below it).
 *
 * Activation stays manual — Enter / Space / click, `Button`'s own behaviour —
 * because every row swaps what the middle column shows.
 *
 * Outside a scope (`GuildRail`, the mobile Sheet, stories, tests of a single
 * group) `SidebarRow` keeps its plain tab-stop behaviour: `useSidebarRowRoving`
 * reports `inScope: false` and changes nothing.
 */

import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react"

/** Marks a row as a member of the scope's order. Queried, never styled. */
export const SIDEBAR_ROW_ATTR = "data-sidebar-row"

interface RovingContextValue {
  /** Which row key owns the single tab stop; `null` until one is claimed. */
  rovingKey: string | null
  setRovingKey: (key: string) => void
  scopeRef: React.RefObject<HTMLElement | null>
}

const SidebarRowRovingContext = createContext<RovingContextValue | null>(null)

/** Arrow keys that move focus within the sidebar, and by how many rows. */
const ROVING_DELTA: Record<string, number> = { ArrowDown: 1, ArrowUp: -1 }

export function SidebarRowsScope({
  children,
  className,
  containerRef,
}: {
  children: ReactNode
  className?: string
  /**
   * Element that contains the rows. Pass one when the rows are spread across
   * a layout that cannot take an extra wrapper — the conversation sidebar
   * stacks them around the list inside one flex column, so it hands over its
   * own root instead. Omitted, the scope renders its own `div`.
   */
  containerRef?: React.RefObject<HTMLElement | null>
}) {
  const ownRef = useRef<HTMLDivElement | null>(null)
  const scopeRef = (containerRef ?? ownRef) as React.RefObject<HTMLElement | null>
  const [rovingKey, setRovingKey] = useState<string | null>(null)

  // Nothing claimed the tab stop (no row is `active` — a fresh workspace, or a
  // route where no nav row matches): hand it to the first row in DOM order, so
  // the sidebar is always reachable by Tab. Runs after every commit because
  // the row set itself changes (teams load, the accordion re-splits); the
  // query is a few dozen nodes and only writes when the answer changed.
  useLayoutEffect(() => {
    const scope = scopeRef.current
    if (!scope) return
    const rows = scope.querySelectorAll<HTMLElement>(`[${SIDEBAR_ROW_ATTR}]`)
    if (rows.length === 0) return
    const claimed = Array.from(rows).some((row) => row.tabIndex === 0)
    if (claimed) return
    const first = rows[0]?.getAttribute(SIDEBAR_ROW_ATTR)
    if (first) setRovingKey((current) => (current === first ? current : first))
  }, [children, scopeRef])

  const value = useMemo<RovingContextValue>(
    () => ({ rovingKey, setRovingKey, scopeRef }),
    [rovingKey, scopeRef]
  )
  if (containerRef) {
    return (
      <SidebarRowRovingContext.Provider value={value}>{children}</SidebarRowRovingContext.Provider>
    )
  }
  return (
    <SidebarRowRovingContext.Provider value={value}>
      <div ref={ownRef} className={className} data-sidebar-rows-scope>
        {children}
      </div>
    </SidebarRowRovingContext.Provider>
  )
}

export interface SidebarRowRoving {
  /** True while inside a `SidebarRowsScope` — otherwise nothing is overridden. */
  inScope: boolean
  /** `0` for the row that owns the tab stop, `-1` for the rest. */
  tabIndex?: number
  /** Attribute pair marking this row as a member of the order. */
  rowProps: Record<string, string>
  onKeyDown?: (event: ReactKeyboardEvent<HTMLElement>) => void
  onFocus?: () => void
}

const OUT_OF_SCOPE: SidebarRowRoving = { inScope: false, rowProps: {} }

/**
 * Wires one row into the scope. `key` must be stable and unique within the
 * sidebar — the row's test id is exactly that, so callers pass it.
 *
 * `active` lets the selected destination hold the tab stop, so tabbing in
 * lands on where you already are rather than at the top of the list.
 */
export function useSidebarRowRoving(key: string | undefined, active: boolean): SidebarRowRoving {
  const context = useContext(SidebarRowRovingContext)
  const rovingKey = context?.rovingKey ?? null
  const setRovingKey = context?.setRovingKey
  const scopeRef = context?.scopeRef

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const delta = ROVING_DELTA[event.key]
    const isEdge = event.key === "Home" || event.key === "End"
    if (delta === undefined && !isEdge) return
    const scope = scopeRef?.current
    if (!scope) return
    const rows = Array.from(scope.querySelectorAll<HTMLElement>(`[${SIDEBAR_ROW_ATTR}]`))
    if (rows.length === 0) return
    const index = rows.indexOf(event.currentTarget as HTMLElement)
    if (index < 0) return
    // The list below binds the same keys to its own focus ring; a row's
    // arrow key belongs to the row, so it stops here.
    event.preventDefault()
    event.stopPropagation()
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? rows.length - 1
          : // No wrap: the sidebar is a column with two ends, and wrapping
            // from the footer back to Canvas reads as a jump, not a move.
            Math.min(rows.length - 1, Math.max(0, index + (delta ?? 0)))
    const next = rows[nextIndex]
    if (!next || next === event.currentTarget) return
    const nextKey = next.getAttribute(SIDEBAR_ROW_ATTR)
    if (nextKey) setRovingKey?.(nextKey)
    next.focus()
  }

  const onFocus = () => {
    // Focus arriving any other way (a click, a screen reader, Shift+Tab back
    // into the sidebar) takes the tab stop with it.
    if (key) setRovingKey?.(key)
  }

  if (!context || !key) return OUT_OF_SCOPE
  const owns = rovingKey === null ? active : rovingKey === key
  return {
    inScope: true,
    tabIndex: owns ? 0 : -1,
    rowProps: { [SIDEBAR_ROW_ATTR]: key },
    onKeyDown: handleKeyDown,
    onFocus,
  }
}
