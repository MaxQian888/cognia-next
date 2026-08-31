"use client"

/**
 * Shared chrome for every floating piece of the selection toolbar.
 *
 * The capsule, the language list, the More menu and the result sheet are four
 * separate surfaces stacked over an arbitrary desktop, and each one used to
 * hand-roll the same four decisions: tint, blur, border, shadow. They drifted.
 * `bg-popover/95` in two places, `/98` in a third, `shadow-xl` against
 * `shadow-2xl`, `rounded-xl` against `rounded-2xl` against `rounded-full`. Over
 * a moving background that reads as four unrelated widgets rather than as one
 * toolbar.
 *
 * So the tint is declared once here, and the geometry goes through
 * `components/surface/surface.tsx`, which owns the tier, radius and elevation
 * scale for the whole app (ADR-0148). Surface paints `--surface-bg` opaquely by
 * default, and these overlays float over the user's own screen and must stay
 * glass, so the tier value is retuned per surface with a custom property. That
 * is exactly the seam Surface documents for this, and it keeps the style pack's
 * radius and elevation axes working, so a squared pack squares the toolbar too.
 */

import { useCallback, useEffect, useRef } from "react"
import { motion } from "motion/react"

import { Surface } from "@/components/surface/surface"
import { cn } from "@/lib/utils"
import { MOBILE_DURATION, MOBILE_EASE } from "@/lib/ui/motion"
import type { SelectionToolbarPlacement } from "@/lib/tauri/selection-toolbar"

/** Border, blur and foreground. The tint travels separately, see below. */
export const SELECTION_GLASS = "border border-border/60 text-popover-foreground backdrop-blur-xl"

/**
 * The tint, as an inline custom property rather than as a class.
 *
 * `[data-surface-layer="overlay"] { --surface-bg: … }` in globals.css is
 * UNLAYERED, and Tailwind's arbitrary-property utilities live in
 * `@layer utilities`. An unlayered declaration beats every layered one whatever
 * its specificity, so a `[--surface-bg:…]` class on a `<Surface>` silently
 * loses and the tier paints opaque. That is the exact trap the settings panel
 * hit, and globals.css had to restate its override unlayered to escape it. An
 * inline style is not in a layer at all, so it wins without a second rule in a
 * stylesheet that cannot see this component.
 *
 * Icon-weight surfaces, meaning the capsule and the two menus. More
 * transparent than the sheet below, because there is no body text to keep
 * legible, so the desktop showing through is atmosphere rather than noise.
 */
export const SELECTION_GLASS_TINT = {
  "--surface-bg": "color-mix(in oklch, var(--popover) 92%, transparent)",
} as React.CSSProperties

/**
 * Text-weight surface, meaning the result sheet, which carries two full
 * paragraphs the user is asked to compare. Contrast wins over atmosphere there.
 */
export const SELECTION_SHEET_TINT = {
  "--surface-bg": "color-mix(in oklch, var(--popover) 97%, transparent)",
} as React.CSSProperties

/** One hairline, used wherever a row of actions changes meaning. */
export function SelectionDivider({ className }: { className?: string }) {
  return <span aria-hidden className={cn("mx-0.5 h-5 w-px shrink-0 bg-border/70", className)} />
}

export interface SelectionListPanelProps {
  /**
   * Reported to Rust as a second hit rect. See `useSelectionToolbarGeometry`.
   * Without it every click in the panel reads as a click *away* and dismisses
   * the candidate before the click's own handler can use it.
   */
  containerRef: React.RefObject<HTMLElement | null>
  placement: SelectionToolbarPlacement
  reduceMotion: boolean
  /** `listbox` picks one value, `menu` fires one command. */
  role: "listbox" | "menu"
  label: string
  onClose: () => void
  /** Item to land focus on when the panel opens or turns a page. */
  focusIndex?: number
  /**
   * Identity of the page currently shown. Changing it re-runs focus placement
   * and asks for a fresh measurement, because a submenu is a different height
   * and nothing outside this component can see that navigation happen.
   */
  pageKey?: string
  /** Stable callback, invoked after every page change. */
  onResize?: () => void
  className?: string
  children: React.ReactNode
}

/**
 * A focus-managed floating list.
 *
 * ADR-0093 traded Radix's `DropdownMenu` for an inline panel, because a
 * portalled `position: fixed` menu sits outside the measured shell, so the
 * native window would never grow to contain it and `overflow: hidden` would
 * crop it. Radix supplied roving focus, arrow keys, Home/End and Escape for
 * free, and the ADR requires that debt to be paid back explicitly, because Rust
 * focuses the window while a panel is open. The keyboard genuinely reaches
 * these lists.
 *
 * It was paid back once, for the language list, and the More menu shipped later
 * without any of it. Owning the behaviour here is what stops the next panel
 * from arriving mouse-only again.
 */
export function SelectionListPanel({
  containerRef,
  placement,
  reduceMotion,
  role,
  label,
  onClose,
  focusIndex = 0,
  pageKey = "",
  onResize,
  className,
  children,
}: SelectionListPanelProps) {
  const localRef = useRef<HTMLDivElement | null>(null)
  // Held in a ref so the focus effect below does not take it as a dependency.
  // It fires a re-measure, and a re-measure re-renders, so an inline callback
  // in that dependency list would be a loop rather than a resize.
  const onResizeRef = useRef(onResize)
  useEffect(() => {
    onResizeRef.current = onResize
  }, [onResize])

  const items = useCallback(
    () =>
      Array.from(
        localRef.current?.querySelectorAll<HTMLElement>("[data-selection-item]") ?? []
      ).filter((item) => !item.hasAttribute("disabled")),
    []
  )

  // Land on the meaningful row rather than nowhere, then re-measure. A submenu
  // is a different height, and the window is sized from a content signature
  // that cannot see this component's own navigation.
  useEffect(() => {
    const all = items()
    all[focusIndex >= 0 && focusIndex < all.length ? focusIndex : 0]?.focus()
    onResizeRef.current?.()
  }, [items, focusIndex, pageKey])

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const all = items()
    if (all.length === 0) return
    const current = all.indexOf(document.activeElement as HTMLElement)
    const focus = (next: number) => {
      event.preventDefault()
      all[((next % all.length) + all.length) % all.length]?.focus()
    }
    switch (event.key) {
      case "ArrowDown":
        focus(current < 0 ? 0 : current + 1)
        break
      case "ArrowUp":
        focus(current < 0 ? 0 : current - 1)
        break
      case "Home":
        focus(0)
        break
      case "End":
        focus(all.length - 1)
        break
      case "Escape":
        event.preventDefault()
        onClose()
        break
      default:
        break
    }
  }

  return (
    <Surface asChild layer="overlay" radius="panel" elevation={3}>
      <motion.div
        ref={(node) => {
          localRef.current = node
          containerRef.current = node
        }}
        role={role}
        aria-label={label}
        aria-orientation="vertical"
        onKeyDown={onKeyDown}
        initial={
          reduceMotion ? false : { opacity: 0, scale: 0.96, y: placement === "above" ? 6 : -6 }
        }
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
        transition={
          reduceMotion ? { duration: 0 } : { duration: MOBILE_DURATION.fast, ease: MOBILE_EASE }
        }
        style={{
          ...SELECTION_GLASS_TINT,
          transformOrigin: placement === "above" ? "bottom center" : "top center",
        }}
        className={cn(
          "selection-scroll pointer-events-auto flex max-h-72 w-max min-w-44 flex-col gap-px overflow-y-auto p-1",
          SELECTION_GLASS,
          className
        )}
      >
        {children}
      </motion.div>
    </Surface>
  )
}

export interface SelectionListItemProps {
  role: "option" | "menuitem"
  label: string
  onClick: () => void
  /**
   * Roving tabindex. Exactly one row in a panel is a tab stop, so Tab moves
   * past the list and the arrows move within it.
   */
  active?: boolean
  /** `option` rows only. Drives `aria-selected` and the trailing check. */
  selected?: boolean
  icon?: React.ReactNode
  /** Muted end-of-row text: the plugin that contributed the row, or its chord. */
  hint?: React.ReactNode
  /** Replaces the default trailing slot. */
  trailing?: React.ReactNode
}

/** One row. The only row style the toolbar's panels have. */
export function SelectionListItem({
  role,
  label,
  onClick,
  active = false,
  selected,
  icon,
  hint,
  trailing,
}: SelectionListItemProps) {
  return (
    <button
      type="button"
      role={role}
      data-selection-item=""
      aria-selected={role === "option" ? selected : undefined}
      tabIndex={active ? 0 : -1}
      onClick={onClick}
      className={cn(
        "group flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-xs",
        "outline-none transition-colors hover:bg-accent hover:text-accent-foreground",
        "focus:bg-accent focus:text-accent-foreground focus-visible:bg-accent",
        selected && "font-medium"
      )}
    >
      {icon ? (
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground transition-colors group-focus:text-foreground group-hover:text-foreground">
          {icon}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint ? (
        <span className="max-w-28 shrink-0 truncate text-[10px] text-muted-foreground">{hint}</span>
      ) : null}
      {trailing}
    </button>
  )
}
