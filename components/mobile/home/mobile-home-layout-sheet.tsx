"use client"

/**
 * The bottom sheet that hosts the phone's glance layout editor
 * (`MobileGlanceEditor`, ADR-0225 §9): the drawer's modules, their home pins
 * and the quick module's shortcuts.
 *
 * Owned by the shell rather than by anything it edits. The home screen can
 * show nothing at all (every module unpinned, or quiet), and a door that lived
 * on the home would go with it; this sheet answers the quick module's "Edit"
 * and the app bar's overflow menu entry, and the second door stays open at
 * every layout state. The Glance drawer's own edit mode renders the same
 * editor in place.
 */

import { useTranslations } from "next-intl"

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { useBackDismiss } from "@/hooks/ui/use-back-dismiss"

import { MobileGlanceEditor } from "@/components/mobile/glance/mobile-glance-editor"

export interface MobileHomeLayoutSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function MobileHomeLayoutSheet({ open, onOpenChange }: MobileHomeLayoutSheetProps) {
  const t = useTranslations("glance.mobile")
  // Android hardware / browser back closes the sheet instead of navigating.
  useBackDismiss(open, () => onOpenChange(false))

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="max-h-[85vh] overflow-y-auto"
        data-testid="mobile-glance-editor-sheet"
      >
        <SheetHeader>
          <SheetTitle>{t("editorTitle")}</SheetTitle>
          <SheetDescription>{t("editorDescription")}</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)]">
          <MobileGlanceEditor />
        </div>
      </SheetContent>
    </Sheet>
  )
}
