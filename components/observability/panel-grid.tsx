"use client"

/**
 * react-grid-layout (v2) wrapper. Renders one draggable/resizable cell per
 * panel in the registry. v2 is a hooks-based rewrite (no `findDOMNode`, so it
 * is React-19 safe): `useContainerWidth` measures the container via
 * ResizeObserver and feeds the required `width` to `ResponsiveGridLayout`;
 * drag/resize live in `dragConfig`/`resizeConfig`. The drag handle is the
 * `.panel-drag-handle` element inside `PanelFrame`.
 *
 * Client-only by nature (ResizeObserver). Safe under the static export: the
 * subtree is `"use client"`, `mounted` is false during SSR/first paint, and
 * the grid only renders once width is measured.
 *
 * **Hidden panels keep their place.** RGL reports a layout containing only
 * the children it rendered, so persisting `onLayoutChange` verbatim deleted
 * every hidden panel's position the first time anything moved — and showing it
 * again dropped a `{w:1,h:1}` stub at the bottom of the grid. `mergeHidden`
 * folds the items RGL did not report back in from the layout it was given, and
 * `normalizePanelLayouts` fills anything still missing from `defaultLayouts()`
 * (min sizes included), both on the way in and on the way out.
 */

import { useMemo, type ReactNode } from "react"
import {
  ResponsiveGridLayout,
  useContainerWidth,
  type Layout,
  type LayoutItem,
  type ResponsiveLayouts,
} from "react-grid-layout"
import "react-grid-layout/css/styles.css"
import { PANELS, defaultLayouts, type PanelDef } from "./panel-registry"
import { normalizePanelLayouts } from "@/lib/observability/dashboard-config"
import type {
  Breakpoint,
  PanelLayoutItem,
  PanelLayouts,
} from "@/stores/observability/observability-store"

const COLS: Record<Breakpoint, number> = { lg: 12, md: 8, sm: 2 }
const BREAKPOINTS: Record<Breakpoint, number> = { lg: 1200, md: 768, sm: 0 }
const MARGIN: readonly [number, number] = [12, 12]

export interface PanelGridProps {
  layouts: PanelLayouts
  editMode: boolean
  onLayoutChange: (layouts: PanelLayouts) => void
  renderPanel: (panel: PanelDef) => ReactNode
  /** Panel ids to hide (RGL ignores layout items without a matching child). */
  hiddenPanels?: string[]
}

/** Keep only the fields the store persists (RGL adds derived ones). */
function pickItem(l: LayoutItem): PanelLayoutItem {
  return { i: l.i, x: l.x, y: l.y, w: l.w, h: l.h, minW: l.minW, minH: l.minH }
}

const BREAKPOINT_KEYS: readonly Breakpoint[] = ["lg", "md", "sm"]

/**
 * RGL's reported layouts → the full persisted set: every breakpoint RGL
 * reported is its visible items PLUS the previous entry of every item it left
 * out (hidden panels); a breakpoint it did not report at all keeps `previous`
 * unchanged. Exported for its test.
 */
export function mergeHidden(all: ResponsiveLayouts, previous: PanelLayouts): PanelLayouts {
  const out = { ...previous }
  for (const bp of BREAKPOINT_KEYS) {
    const reported = all[bp] as Layout | undefined
    if (!reported) continue
    const visible = reported.map(pickItem)
    const seen = new Set(visible.map((item) => item.i))
    out[bp] = [...visible, ...previous[bp].filter((item) => !seen.has(item.i))]
  }
  return normalizePanelLayouts(out, defaultLayouts())
}

export function PanelGrid({
  layouts,
  editMode,
  onLayoutChange,
  renderPanel,
  hiddenPanels,
}: PanelGridProps) {
  const { width, containerRef, mounted } = useContainerWidth()
  const hidden = new Set(hiddenPanels ?? [])
  const visiblePanels = PANELS.filter((p) => !hidden.has(p.id))
  // A stored layout from an older registry (or a hand-edited import) is made
  // whole before RGL sees it, so it never has to invent a tile.
  const complete = useMemo(() => normalizePanelLayouts(layouts, defaultLayouts()), [layouts])

  return (
    <div ref={containerRef} className="w-full" data-testid="panel-grid">
      {mounted && (
        <ResponsiveGridLayout
          width={width}
          className="layout"
          layouts={complete as unknown as ResponsiveLayouts}
          breakpoints={BREAKPOINTS}
          cols={COLS}
          rowHeight={40}
          margin={MARGIN}
          dragConfig={{ enabled: editMode, handle: ".panel-drag-handle" }}
          resizeConfig={{ enabled: editMode }}
          onLayoutChange={(_layout: Layout, all: ResponsiveLayouts) =>
            onLayoutChange(mergeHidden(all, complete))
          }
        >
          {visiblePanels.map((panel) => (
            <div key={panel.id} className="min-h-0 overflow-hidden">
              {renderPanel(panel)}
            </div>
          ))}
        </ResponsiveGridLayout>
      )}
    </div>
  )
}
