"use client"

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { SettingsShell } from "@/components/settings/settings-shell"
import { useTranslations } from "next-intl"
import type { SettingsSectionId } from "@/components/settings/settings-nav-config"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultTab?: string
}

/**
 * Settings host. Renders the unified `<SettingsShell>` (sidebar + grouped
 * navigation + content panel) inside a wide sheet. Mirrors Cognia's
 * `app/(main)/settings/page.tsx` layout but adapted to fit the sheet host so
 * users don't lose the chat context while configuring.
 *
 * The `defaultTab` prop maps to the new section ids (general, api-key, ...).
 * Older callers passing legacy values keep working — `<SettingsShell>` falls
 * back to "general" for unknowns.
 */
export function SettingsDialog({ open, onOpenChange, defaultTab = "general" }: Props) {
  const t = useTranslations("settings")
  const onClose = () => onOpenChange(false)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl"
        // Tauri-window mode is wide; keep the sheet flush to ~80% on small
        // screens but cap at 1100px for readability on large monitors.
        style={{ maxWidth: "min(1100px, 92vw)" }}
      >
        <SheetHeader className="sr-only">
          <SheetTitle>{t("title")}</SheetTitle>
          <SheetDescription>{t("description")}</SheetDescription>
        </SheetHeader>
        <div className="flex-1 min-h-0 overflow-hidden">
          <SettingsShell
            embedded
            defaultSection={(defaultTab as SettingsSectionId) ?? "general"}
            onClose={onClose}
          />
        </div>
      </SheetContent>
    </Sheet>
  )
}
