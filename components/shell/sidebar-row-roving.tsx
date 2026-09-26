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
 * The icon rail (`GuildRail`) is a scope of its own: its buttons call
 * `useSidebarRowRoving` directly, and the controls it hosts but does not
 * render — the web shell's status segments, plugin contributions — join
 * through `SidebarRovingGroup`, which enrols whatever buttons end up inside it.
 *
 * Outside a scope (the mobile Sheet, stories, tests of a single group)
 * `SidebarRow` keeps its plain tab-stop behaviour: `useSidebarRowRoving`
 * reports `inScope: false` and changes nothing.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react"

/** Marks a row as a member of the scope's order. Queried, never styled. */
export const SIDEBAR_ROW_ATTR = "data-sidebar-row"

interface RovingContextValue {
  /** Which row key owns the single tab stop; `null` until one is claimed. */
  rovingKey: string | null
  setRovingKey: React.Dispatch<React.SetStateAction<string | null>>
  scopeRef: React.RefObject<HTMLElement | null>
}

const SidebarRowRovingContext = createContext<RovingContextValue | null>(null)

/** Arrow keys that move focus within the sidebar, and by how many rows. */
const ROVING_DELTA: Record<string, number> = { ArrowDown: 1, ArrowUp: -1 }

function scopeRows(scope: HTMLElement): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>(`[${SIDEBAR_ROW_ATTR}]`))
}

/**
 * Hand the tab stop to the first row when no row holds it. The scope runs
 * it after its own commits; a `SidebarRovingGroup` runs it after enrolling
 * rows the scope's render never saw. The query is a few dozen nodes and only
 * writes when the answer changed.
 */
function claimFirstIfUnclaimed(
  scope: HTMLElement | null | undefined,
  setRovingKey: React.Dispatch<React.SetStateAction<string | null>>
) {
  if (!scope) return
  const rows = scopeRows(scope)
  if (rows.length === 0) return
  if (rows.some((row) => row.tabIndex === 0)) return
  const first = rows[0]?.getAttribute(SIDEBAR_ROW_ATTR)
  if (first) setRovingKey((current) => (current === first ? current : first))
}

/**
 * Arrow / Home / End from `from` to its neighbour in DOM order. Returns false
 * — and leaves the event alone — for any other key, or when `from` is not a
 * row of this scope.
 */
function moveRovingFocus(
  event: ReactKeyboardEvent<HTMLElement>,
  from: HTMLElement,
  scope: HTMLElement | null | undefined,
  setRovingKey: ((key: string) => void) | undefined
): boolean {
  const delta = ROVING_DELTA[event.key]
  const isEdge = event.key === "Home" || event.key === "End"
  if (delta === undefined && !isEdge) return false
  if (!scope) return false
  const rows = scopeRows(scope)
  const index = rows.indexOf(from)
  if (index < 0) return false
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
  if (!next || next === from) return true
  const nextKey = next.getAttribute(SIDEBAR_ROW_ATTR)
  if (nextKey) setRovingKey?.(nextKey)
  next.focus()
  return true
}

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
  // the row set itself changes (teams load, the accordion re-splits).
  useLayoutEffect(() => {
    claimFirstIfUnclaimed(scopeRef.current, setRovingKey)
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
    moveRovingFocus(event, event.currentTarget, scopeRef?.current, setRovingKey)
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

/** What a `SidebarRovingGroup` considers a control of its own. */
const GROUP_CANDIDATES = "button, a[href], [tabindex]"
const NATIVELY_FOCUSABLE = "button, a[href]"

/**
 * The controls inside `root` that should take a place in the order: enabled
 * buttons and links, plus anything opted in with a non-negative `tabindex` —
 * or already enrolled by this group (whose `tabindex` it set to `-1` itself).
 * A control nested inside another one is the outer control's business.
 */
function groupMembers(root: HTMLElement, prefix: string): HTMLElement[] {
  const candidates = Array.from(root.querySelectorAll<HTMLElement>(GROUP_CANDIDATES)).filter(
    (element) => {
      if ((element as HTMLButtonElement).disabled) return false
      if (element.matches(NATIVELY_FOCUSABLE)) return true
      if (element.getAttribute(SIDEBAR_ROW_ATTR)?.startsWith(prefix)) return true
      return element.tabIndex >= 0
    }
  )
  return candidates.filter(
    (element) => !candidates.some((other) => other !== element && other.contains(element))
  )
}

/**
 * Enrols controls this scope does not render into its roving order.
 *
 * The icon rail hosts two kinds of foreign buttons: the web shell's global
 * status segments (`WebGlobalStatusRail`, a dozen unrelated components) and
 * plugin contributions (`PluginExtensionSlot`). Threading the roving hook
 * into each of them is not possible, so the group does it from outside: after
 * every commit — and whenever a segment mounts, unmounts or toggles
 * `disabled` — it marks each control inside it as a row (keyed by its test
 * id when it has one, by position otherwise) and gives it the tab index the
 * scope decides. Arrows / Home / End on those controls are taken in the
 * capture phase, before the control's own handler, so a dropdown trigger's
 * ArrowDown moves along the rail like every other button instead of opening
 * its menu; Enter / Space still open it.
 *
 * Outside a `SidebarRowsScope` it renders its wrapper and changes nothing.
 * The wrapper is a plain `div` — pass `className="contents"` to keep it out
 * of the layout.
 */
export function SidebarRovingGroup({
  groupKey,
  className,
  children,
}: {
  /** Prefix for the enrolled rows' keys; unique within the scope. */
  groupKey: string
  className?: string
  children: ReactNode
}) {
  const context = useContext(SidebarRowRovingContext)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const rovingKey = context?.rovingKey ?? null
  const setRovingKey = context?.setRovingKey
  const scopeRef = context?.scopeRef
  const inScope = context !== null
  const prefix = `${groupKey}:`
  // Read by the mutation observer, which outlives any one render.
  const rovingKeyRef = useRef(rovingKey)

  const enrol = useCallback(() => {
    const root = rootRef.current
    if (!root || !inScope) return
    const members = groupMembers(root, prefix)
    const memberSet = new Set(members)
    // A control that left the group's reach (disabled now) leaves the order.
    for (const stale of Array.from(
      root.querySelectorAll<HTMLElement>(`[${SIDEBAR_ROW_ATTR}^="${prefix}"]`)
    )) {
      if (!memberSet.has(stale)) stale.removeAttribute(SIDEBAR_ROW_ATTR)
    }
    members.forEach((element, index) => {
      const key = `${prefix}${element.dataset.testid ?? index}`
      if (element.getAttribute(SIDEBAR_ROW_ATTR) !== key) {
        element.setAttribute(SIDEBAR_ROW_ATTR, key)
      }
      const tabIndex = rovingKeyRef.current === key ? 0 : -1
      if (element.tabIndex !== tabIndex || !element.hasAttribute("tabindex")) {
        element.tabIndex = tabIndex
      }
    })
  }, [inScope, prefix])

  // Every commit: the scope's tab stop may have moved, or a segment
  // re-rendered with a fresh element. No claim here — sibling groups have not
  // enrolled yet; the scope's own layout effect runs after all of them.
  useLayoutEffect(() => {
    rovingKeyRef.current = rovingKey
    enrol()
  })

  // Segments mount on their own schedule (a store flips, a probe resolves),
  // without re-rendering this group. Only structure and `disabled` are
  // watched — never the attributes `enrol` writes, so it cannot feed itself.
  useEffect(() => {
    const root = rootRef.current
    if (!root || !inScope || typeof MutationObserver === "undefined") return
    // Outside a commit nobody else will re-check the tab stop, so a segment
    // that took it and then unmounted hands it on here.
    const observer = new MutationObserver(() => {
      enrol()
      if (setRovingKey) claimFirstIfUnclaimed(scopeRef?.current, setRovingKey)
    })
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["disabled"],
    })
    return () => observer.disconnect()
  }, [enrol, inScope, scopeRef, setRovingKey])

  /** The enrolled control an event started on, if it started on one. */
  const memberOf = (target: EventTarget | null): HTMLElement | null => {
    const root = rootRef.current
    if (!root || !(target instanceof HTMLElement) || !root.contains(target)) return null
    return target.getAttribute(SIDEBAR_ROW_ATTR)?.startsWith(prefix) ? target : null
  }

  const onKeyDownCapture = (event: ReactKeyboardEvent<HTMLElement>) => {
    const member = memberOf(event.target)
    if (!member) return
    moveRovingFocus(event, member, scopeRef?.current, setRovingKey)
  }
  const onFocus = (event: ReactFocusEvent<HTMLElement>) => {
    const key = memberOf(event.target)?.getAttribute(SIDEBAR_ROW_ATTR)
    if (key) setRovingKey?.(key)
  }

  return (
    <div
      ref={rootRef}
      className={className}
      data-sidebar-roving-group={groupKey}
      onKeyDownCapture={inScope ? onKeyDownCapture : undefined}
      onFocus={inScope ? onFocus : undefined}
    >
      {children}
    </div>
  )
}
