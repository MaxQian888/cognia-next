"use client"

/**
 * The bottom sheet that hosts `MobileQuickActionsEditor`.
 *
 * Lifted out of `mobile-quick-actions.tsx`, which used to own it. That was the
 * editor's only mount, and the grid around it renders `null` as soon as its own
 * `quickActions` section is hidden. Hiding the grid therefore took the editor
 * with it and there was no way back. Owned by the shell instead, the same sheet
 * answers both the grid's "Edit" button and the app bar's overflow menu entry,
 * and the second door stays open at every layout state.
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

import { MobileQuickActionsEditor } from "./mobile-quick-actions-editor"

export interface MobileHomeLayoutSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function MobileHomeLayoutSheet({ open, onOpenChange }: MobileHomeLayoutSheetProps) {
  const t = useTranslations("mobile.home")
  // Android hardware / browser back closes the sheet instead of navigating.
  useBackDismiss(open, () => onOpenChange(false))

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="max-h-[85vh] overflow-y-auto"
        data-testid="mobile-quick-actions-editor-sheet"
      >
        <SheetHeader>
          <SheetTitle>{t("customize.title")}</SheetTitle>
          <SheetDescription>{t("customize.description")}</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)]">
          <MobileQuickActionsEditor />
        </div>
      </SheetContent>
    </Sheet>
  )
}
