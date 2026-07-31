"use client"

/**
 * Standalone "Customize layout" dialog — a thin shell around
 * `<ShellLayoutCustomizer/>`, opened on whichever surface the user right-clicked.
 *
 * Entry points: the nav rail's "More" popover footer and its item context menu
 * (`surface="sidebar"`), the title bar's context menu and Views menu
 * (`surface="title"`), and the status bar's context menu (`surface="status"`).
 * The Settings section (`components/settings/sidebar/shell-layout-section.tsx`)
 * renders the same customizer inline rather than in a dialog.
 *
 * It replaced the sidebar-only dialog: the bars had no editor of their own, and
 * a second near-identical dialog for them would have split "where do I change
 * the chrome" across two places.
 */

import * as React from "react"
import { useTranslations } from "next-intl"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ShellLayoutCustomizer, type ShellSurface } from "./shell-layout-customizer"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Tab to open on. Defaults to the nav rail. */
  surface?: ShellSurface
}

export function ShellLayoutDialog({
  open,
  onOpenChange,
  surface = "sidebar",
}: Props): React.ReactElement {
  const t = useTranslations("desktop.shellLayout")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="shell-layout-dialog">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description.dialog")}</DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[60vh] pr-3">
          {/* Keyed on `surface`: the user is free to switch tabs inside the
              dialog, but re-opening from a different entry point remounts the
              customizer on that entry point's surface. */}
          <ShellLayoutCustomizer key={surface} defaultSurface={surface} />
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
