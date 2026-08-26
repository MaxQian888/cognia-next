"use client"

/**
 * The shared master/detail frame for settings sections that drive a detail
 * pane from a nav rail.
 *
 * ## Why this exists
 *
 * Eleven sections had shipped byte-similar copies of the same block:
 * `grid grid-cols-1 gap-4 md:grid-cols-[NNNpx_1fr]`, a `hidden md:flex` rail,
 * and a `md:hidden` Sheet trigger. Every one of them was wrong in the same
 * way — `md` is a **viewport** media query, but this pane never gets the
 * viewport. It gets what is left after the app rail (~56px), the settings
 * sidebar (15rem), and the shell padding. In an 835px window the pane is
 * 491px wide, so a 320px rail left the detail column 171px: wide enough to
 * paint a border, not wide enough to hold the form the user came for. The
 * breakpoint fired at 768px of *window* while the pane was still 440px.
 *
 * So the tiers here are container queries on the pane itself, and the rail
 * degrades instead of vanishing:
 *
 * | pane width | rail                                   | detail  |
 * | ---------- | -------------------------------------- | ------- |
 * | >= 860px   | full — icon + label + description      | rest    |
 * | >= 620px   | compact 200px — icon + label           | rest    |
 * | >= 440px   | icon 52px — glyph only, label in title | rest    |
 * | <  440px   | none — a Sheet behind a trigger row    | all     |
 *
 * Nothing is ever *removed* from the accessible tree on the way down: the
 * label, description and badge go `sr-only`, so a screen reader still reads
 * the same row at the icon tier that it reads at the full tier. That is why
 * the nav components tag those spans with `data-nav-label` / `data-nav-desc`
 * / `data-nav-badge` / `data-nav-group` instead of the frame reaching in with
 * positional selectors.
 *
 * ## The measured density
 *
 * Layout is CSS — no resize handler decides where a column goes, so there is
 * no first-paint flash and no jitter mid-drag. `useSettingsPaneDensity()`
 * exists only for the things CSS genuinely cannot express: whether to attach
 * a hover title at the icon tier, and whether a panel should open a tall
 * optional block (Appearance's live preview) expanded. Treat CSS as the
 * authority for *where* things sit and the hook as the authority for *how a
 * panel behaves* — if the two disagree for one frame during a drag, nothing
 * moves.
 */

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { LayoutGroup } from "motion/react"
import { MenuIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { useElementWidth } from "@/hooks/use-element-width"
import { cn } from "@/lib/utils"

export type SettingsPaneDensity = "sheet" | "icon" | "compact" | "full"

/**
 * Pane widths at which each tier takes over, in px. Exported so the nav
 * components and their tests can name the same numbers the CSS below uses —
 * a tier boundary that drifts between the two would show up as a rail that
 * is 52px wide while its rows still render descriptions.
 */
export const SETTINGS_PANE_TIERS = { icon: 440, compact: 620, full: 860 } as const

/** Rail width for the icon tier. Matches the `grid-cols` value below. */
export const SETTINGS_RAIL_ICON_WIDTH = 52

/** Rail width for the compact tier. Matches the `grid-cols` value below. */
export const SETTINGS_RAIL_COMPACT_WIDTH = 200

/** Full-tier rail width when a section does not name its own. */
const DEFAULT_NAV_WIDTH = 300

export function densityForWidth(width: number): SettingsPaneDensity {
  // 0 means "not measured yet" (`useElementWidth`'s documented sentinel).
  // Assuming the widest tier is the safe guess: it is what desktop actually
  // gets, and a panel that opens expanded and then collapses on the next
  // frame is less jarring than the reverse.
  if (width <= 0) return "full"
  if (width >= SETTINGS_PANE_TIERS.full) return "full"
  if (width >= SETTINGS_PANE_TIERS.compact) return "compact"
  if (width >= SETTINGS_PANE_TIERS.icon) return "icon"
  return "sheet"
}

const DensityContext = createContext<SettingsPaneDensity>("full")

/**
 * The measured tier of the nearest `SettingsMasterDetail`. Returns `"full"`
 * outside one, so a panel rendered on its own route (`/me/logs`) behaves as
 * it did before rather than degrading to a mobile shape.
 */
export function useSettingsPaneDensity(): SettingsPaneDensity {
  return useContext(DensityContext)
}

/**
 * Density classes applied to the rail wrapper. Written mobile-first: the base
 * rules are the icon tier and each container query adds back what the extra
 * width pays for.
 */
const RAIL_DENSITY_CLASSES = cn(
  // `data-nav-text` is the wrapper holding a row's label and description;
  // taking the wrapper out of flow is what lets the glyph actually centre in a
  // 52px rail — a `flex-1` wrapper with two absolutely-positioned children
  // still measures zero but keeps eating the row.
  "[&_[data-nav-row]]:justify-center [&_[data-nav-row]]:gap-0 [&_[data-nav-row]]:px-0",
  "[&_[data-nav-text]]:sr-only [&_[data-nav-label]]:sr-only [&_[data-nav-desc]]:sr-only",
  "[&_[data-nav-badge]]:sr-only [&_[data-nav-group]]:sr-only",
  // With the group headings out of flow the groups would run together into one
  // undifferentiated column of glyphs, so a hairline stands in for the heading.
  "[&_[data-nav-group-block]+[data-nav-group-block]]:mt-1",
  "[&_[data-nav-group-block]+[data-nav-group-block]]:border-t",
  "[&_[data-nav-group-block]+[data-nav-group-block]]:pt-1",
  "@[620px]/settings-pane:[&_[data-nav-row]]:justify-start",
  "@[620px]/settings-pane:[&_[data-nav-row]]:gap-2",
  "@[620px]/settings-pane:[&_[data-nav-row]]:px-2",
  "@[620px]/settings-pane:[&_[data-nav-text]]:not-sr-only",
  "@[620px]/settings-pane:[&_[data-nav-label]]:not-sr-only",
  "@[620px]/settings-pane:[&_[data-nav-badge]]:not-sr-only",
  "@[620px]/settings-pane:[&_[data-nav-group]]:not-sr-only",
  "@[620px]/settings-pane:[&_[data-nav-group-block]+[data-nav-group-block]]:mt-0",
  "@[620px]/settings-pane:[&_[data-nav-group-block]+[data-nav-group-block]]:border-t-0",
  "@[620px]/settings-pane:[&_[data-nav-group-block]+[data-nav-group-block]]:pt-0",
  // Descriptions stay out of flow through the compact tier and only come back
  // at the full one, which is the whole reason `compact` is its own tier
  // rather than a narrower `full`.
  "@[860px]/settings-pane:[&_[data-nav-desc]]:not-sr-only"
)

/**
 * Column track per tier. `--settings-rail-w` carries the section's own
 * full-tier width so the one shared class string covers a 260px rail
 * (Logs, Memory) and a 360px one (OCR) without a variant per section.
 */
const GRID_CLASSES = cn(
  "grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] gap-4",
  "@[440px]/settings-pane:grid-rows-1",
  "@[440px]/settings-pane:grid-cols-[52px_minmax(0,1fr)]",
  "@[620px]/settings-pane:grid-cols-[200px_minmax(0,1fr)]",
  "@[860px]/settings-pane:grid-cols-[var(--settings-rail-w)_minmax(0,1fr)]"
)

export interface SettingsMasterDetailProps {
  /**
   * The nav, rendered once per slot. A render prop rather than a node because
   * the rail and the Sheet are two live instances: `SettingsPanelNav` and
   * `memory-nav` move their selection pill with a shared-layout `layoutId`,
   * and two mounted navs sharing one id fight over the pill mid-animation.
   *
   * `slot` is available so a caller CAN vary its own ids, but it no longer has
   * to: each slot is wrapped in its own `LayoutGroup` below, which namespaces
   * every `layoutId` beneath it. Most sections returned the same node for both
   * slots — and since the rail is CSS-hidden rather than unmounted at the
   * drawer tier, both were live at once and the pill did fight.
   */
  nav: (slot: "rail" | "sheet") => ReactNode
  /** Accessible name for the rail, and the Sheet's title. */
  navTitle: string
  /** Label on the button that opens the Sheet at the narrowest tier. */
  mobileTriggerLabel: string
  /**
   * Which panel is open. Only used to close the Sheet after a selection —
   * every section was calling `setSheetOpen(false)` from its own `onSelect`,
   * which is the same rule written eleven times and missed wherever
   * navigation happened from somewhere other than the nav.
   */
  activeKey: string
  /** Name of the open panel, shown beside the trigger at the narrowest tier. */
  activeLabel?: string
  /** Full-tier rail width in px. */
  navWidth?: number
  /** Preserved so a section's existing tests keep addressing the trigger. */
  triggerTestId?: string
  className?: string
  /** Set on the frame's root, for sections whose tests address the pane. */
  "data-testid"?: string
  /** The detail pane. Rendered as the grid's second cell, unwrapped. */
  children: ReactNode
}

export function SettingsMasterDetail({
  nav,
  navTitle,
  mobileTriggerLabel,
  activeKey,
  activeLabel,
  navWidth = DEFAULT_NAV_WIDTH,
  triggerTestId,
  className,
  "data-testid": testId,
  children,
}: SettingsMasterDetailProps) {
  const paneRef = useRef<HTMLDivElement>(null)
  const density = densityForWidth(useElementWidth(paneRef))
  const [sheetOpen, setSheetOpen] = useState(false)

  // Selection closes the drawer, wherever the selection came from — a nav
  // row, a deep link, a cross-panel jump. Skips the first commit because the
  // drawer starts closed anyway.
  const seenKey = useRef(activeKey)
  useEffect(() => {
    if (seenKey.current === activeKey) return
    seenKey.current = activeKey
    setSheetOpen(false)
  }, [activeKey])

  return (
    <div
      ref={paneRef}
      className={cn("@container/settings-pane flex min-h-0 flex-1 flex-col", className)}
      data-settings-pane-density={density}
      data-testid={testId}
    >
      <div
        className={GRID_CLASSES}
        style={{ "--settings-rail-w": `${navWidth}px` } as React.CSSProperties}
      >
        <div
          className={cn(
            "hidden min-h-0 rounded-lg border",
            "@[440px]/settings-pane:flex @[440px]/settings-pane:flex-col @[440px]/settings-pane:overflow-hidden",
            RAIL_DENSITY_CLASSES
          )}
          data-testid="settings-master-rail"
        >
          {/* Own layout namespace — see the `nav` prop's doc. */}
          <LayoutGroup id="settings-nav-rail">
            <DensityContext.Provider value={density}>{nav("rail")}</DensityContext.Provider>
          </LayoutGroup>
        </div>

        {/* The Sheet's own subtree is portalled to the body, so none of the
            rail's container queries reach it — the drawer always renders the
            nav at full density, which is what a drawer is for. */}
        <div className="flex items-center gap-2 @[440px]/settings-pane:hidden">
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 gap-1.5"
                data-testid={triggerTestId}
              >
                <MenuIcon className="size-4" />
                {mobileTriggerLabel}
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="flex w-[300px] flex-col p-0">
              <SheetHeader className="px-3 pt-3">
                <SheetTitle className="text-sm">{navTitle}</SheetTitle>
              </SheetHeader>
              <LayoutGroup id="settings-nav-sheet">{nav("sheet")}</LayoutGroup>
            </SheetContent>
          </Sheet>
          {activeLabel ? (
            <p className="min-w-0 flex-1 truncate text-sm font-medium">{activeLabel}</p>
          ) : null}
        </div>

        {children}
      </div>
    </div>
  )
}

/**
 * Pane width at which a *list*+detail pane splits into two columns.
 *
 * Lower than the nav frame's own thresholds because the master here is a
 * searchable list of things (adapters, crash reports, search providers) rather
 * than a fixed set of panels: it stays useful much narrower than a nav rail
 * whose rows carry a label and a description, and it has no icon-only form to
 * degrade into.
 */
export const SETTINGS_LIST_DETAIL_COLLAPSE = 560

/**
 * Frame for the settings panes whose master is a list rather than a nav.
 *
 * Same defect, same fix as `SettingsMasterDetail`: `md:grid-cols-[NNNpx_1fr]`
 * measured the viewport, which this pane never gets. The difference is what
 * happens on the way down — a list has no icon tier, so there is one threshold,
 * and above it the column is fluid (`clamp`) instead of a fixed px so the
 * detail side keeps a usable share at every width in between.
 *
 * Children are the grid's cells: the caller still owns its own master, its own
 * narrow-width affordance (a drawer, an accordion), and its own detail markup —
 * those differ per pane and are not worth unifying.
 */
export function SettingsListDetail({
  listWidth = 300,
  className,
  "data-testid": testId,
  children,
}: {
  /** Upper bound for the master column. The clamp never exceeds it. */
  listWidth?: number
  className?: string
  "data-testid"?: string
  children: ReactNode
}) {
  return (
    <div
      className={cn("@container/settings-pane flex min-h-0 flex-1 flex-col", className)}
      data-testid={testId}
    >
      <div
        className={cn(
          "grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] gap-4",
          "@[560px]/settings-pane:grid-rows-1",
          // `cqi` is a share of *this* pane, so the master grows with the pane
          // instead of stepping once at a viewport breakpoint and then staying
          // put while the detail column absorbs every pixel of the difference.
          "@[560px]/settings-pane:grid-cols-[clamp(200px,30cqi,var(--settings-rail-w))_minmax(0,1fr)]"
        )}
        style={{ "--settings-rail-w": `${listWidth}px` } as React.CSSProperties}
      >
        {children}
      </div>
    </div>
  )
}
