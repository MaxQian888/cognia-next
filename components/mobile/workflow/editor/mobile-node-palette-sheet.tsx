"use client"

/**
 * Mobile node palette — a bottom sheet (opened by the editor's FAB) that
 * reuses the desktop `NodeSearchSidebar`. The sidebar already supports
 * tap-to-add via `onAddNodeAtCenter` (the desktop side calls it on click,
 * falling back from HTML5 drag); on touch we lean entirely on the tap path.
 *
 * `embedded` strips the sidebar's side-rail chrome + drag-hint footer so it
 * reads as native sheet content.
 */

import { useTranslations } from "next-intl"

import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { NodeSearchSidebar } from "@/components/workflow/editor/node-search-sidebar"
import type { NodeCatalogEntry } from "@/lib/workflow/nodes/catalog"

export interface MobileNodePaletteSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Add the picked node — the editor positions it + selects it, then closes. */
  onAdd: (entry: NodeCatalogEntry) => void
}

export function MobileNodePaletteSheet({ open, onOpenChange, onAdd }: MobileNodePaletteSheetProps) {
  const t = useTranslations("mobile.workflow.editor")
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        // Clamp to the dynamic viewport minus the safe-area inset so the search
        // + list never get cut off on short / notched devices (foldables,
        // landscape) where a flat 80vh would overflow.
        className="h-[80vh] max-h-[calc(100dvh-env(safe-area-inset-top,0px)-2rem)] gap-0 p-0"
        data-testid="mobile-node-palette"
        aria-describedby={undefined}
      >
        <SheetHeader className="border-b">
          <SheetTitle className="text-sm">{t("addNode")}</SheetTitle>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-hidden">
          <NodeSearchSidebar embedded onAddNodeAtCenter={onAdd} />
        </div>
      </SheetContent>
    </Sheet>
  )
}
