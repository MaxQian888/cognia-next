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
 */

import type { ReactNode } from "react"
import {
  ResponsiveGridLayout,
  useContainerWidth,
  type Layout,
  type LayoutItem,
  type ResponsiveLayouts,
} from "react-grid-layout"
import "react-grid-layout/css/styles.css"
import { PANELS, type PanelDef } from "./panel-registry"
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
}

/** Keep only the fields the store persists (RGL adds derived ones). */
function pickItem(l: LayoutItem): PanelLayoutItem {
  return { i: l.i, x: l.x, y: l.y, w: l.w, h: l.h, minW: l.minW, minH: l.minH }
}

function pickLayouts(all: ResponsiveLayouts): PanelLayouts {
  const at = (bp: Breakpoint): PanelLayoutItem[] => ((all[bp] ?? []) as Layout).map(pickItem)
  return { lg: at("lg"), md: at("md"), sm: at("sm") }
}

export function PanelGrid({ layouts, editMode, onLayoutChange, renderPanel }: PanelGridProps) {
  const { width, containerRef, mounted } = useContainerWidth()

  return (
    <div ref={containerRef} className="w-full" data-testid="panel-grid">
      {mounted && (
        <ResponsiveGridLayout
          width={width}
          className="layout"
          layouts={layouts as unknown as ResponsiveLayouts}
          breakpoints={BREAKPOINTS}
          cols={COLS}
          rowHeight={40}
          margin={MARGIN}
          dragConfig={{ enabled: editMode, handle: ".panel-drag-handle" }}
          resizeConfig={{ enabled: editMode }}
          onLayoutChange={(_layout: Layout, all: ResponsiveLayouts) =>
            onLayoutChange(pickLayouts(all))
          }
        >
          {PANELS.map((panel) => (
            <div key={panel.id} className="min-h-0 overflow-hidden">
              {renderPanel(panel)}
            </div>
          ))}
        </ResponsiveGridLayout>
      )}
    </div>
  )
}
