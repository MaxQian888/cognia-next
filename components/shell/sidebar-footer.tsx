"use client"

/**
 * The expanded sidebar's bottom row: Settings, plus whatever plugins pin to
 * the rail's bottom slot. The icon column ends the same way (`guild-rail.tsx`),
 * so a user who collapses the sidebar finds the gear in the same corner.
 */

import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import { SettingsIcon } from "lucide-react"
import { loggers } from "@cognia/logging"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { cn } from "@/lib/utils"
import { SidebarRow } from "./sidebar-nav-section"
import { useShellNav } from "./use-shell-nav"

const log = loggers.ui

export function SidebarFooter({ className }: { className?: string }) {
  const t = useTranslations("desktop.guildRail")
  const router = useRouter()
  const { isFeatureActive } = useShellNav()
  return (
    <div
      data-testid="sidebar-footer"
      className={cn("flex shrink-0 flex-col gap-px border-t px-2 py-1", className)}
    >
      {/* Icon strip, matching the declared `icon` form factor and the icon
          column's own footer — see `sidebar-nav-section.tsx`. */}
      <PluginExtensionSlot
        point="sidebar.left.bottom"
        className="flex flex-wrap items-center gap-1 pb-1 empty:hidden"
      />
      <SidebarRow
        active={isFeatureActive("/settings")}
        onClick={() => {
          log.info("guild open settings")
          router.push("/settings")
        }}
        icon={<SettingsIcon />}
        label={t("settings")}
        // No `aria-label` override: the visible label *is* the accessible name.
        // "Open settings" over a row that reads "Settings" is a WCAG 2.5.3
        // (label-in-name) mismatch — voice control users say what they see.
        testId="sidebar-footer-settings"
      />
    </div>
  )
}
