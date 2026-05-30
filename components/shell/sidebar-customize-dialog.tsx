"use client"

/**
 * Standalone "Customize sidebar" dialog — a thin shell around
 * `<SidebarCustomizer/>`. Hosted by `GuildRail` and opened from the "More"
 * popover footer or a rail item's right-click context menu. The Settings
 * section (`components/settings/sidebar/sidebar-section.tsx`) renders the same
 * customizer inline rather than in a dialog.
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
import { SidebarCustomizer } from "./sidebar-customizer"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SidebarCustomizeDialog({ open, onOpenChange }: Props): React.ReactElement {
  const t = useTranslations("desktop.guildRail")
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="sidebar-customize-dialog">
        <DialogHeader>
          <DialogTitle>{t("customize.title")}</DialogTitle>
          <DialogDescription>{t("customize.description")}</DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[60vh] pr-3">
          <SidebarCustomizer />
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
