"use client"

/**
 * The expanded sidebar's bottom block: the account card, the rail's two
 * one-click utilities beside it, and whatever plugins pin to the rail's
 * bottom slot.
 *
 * It used to be a Settings row. The gear moved into the account card's menu
 * (`sidebar-user-card.tsx`) because the footer was the last unclaimed line of
 * the rail and a person belongs there more than a preferences shortcut does:
 * the profile, the cloud identity bound to it, the usage it is spending and the
 * lock that closes it were spread across a status-bar glyph and two settings
 * sections, with nothing on the rail naming whose workspace this is. Theme and
 * Settings also stay beside the card as plain buttons — the menu keeps them
 * discoverable, the buttons keep them one click.
 *
 * The 56px icon column keeps its own gear (`guild-rail.tsx`), so collapsing the
 * sidebar still finds Settings in the same corner.
 */

import { useCallback } from "react"
import { useRouter } from "next/navigation"
import { useTheme } from "next-themes"
import { useTranslations } from "next-intl"
import { MoonIcon, SettingsIcon, SunIcon, SunMoonIcon } from "lucide-react"

import type { AppTheme } from "@cognia/agent-config-types"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { Button } from "@/components/ui/button"
import { useSettingsStore } from "@/stores/settings"
import { cn } from "@/lib/utils"
import { SidebarUserCard } from "./sidebar-user-card"
import { SharedSessionJoin } from "@/components/chat/shared-session-join"

// The same stops the mobile quick toggles cycle through (system → light →
// dark) so the two surfaces never disagree about what "next" means.
const THEME_CYCLE: AppTheme[] = ["system", "light", "dark"]

export function SidebarFooter({ className }: { className?: string }) {
  const t = useTranslations("desktop.sidebarUser")
  const router = useRouter()
  const { theme, setTheme } = useTheme()
  const save = useSettingsStore((s) => s.save)

  const themeSetting: AppTheme =
    theme === "light" || theme === "dark" || theme === "system" ? theme : "system"
  const cycleTheme = useCallback(() => {
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(themeSetting) + 1) % THEME_CYCLE.length]
    // next-themes gives instant feedback; the settings write is what survives
    // the next `SettingsSyncProvider` re-apply (the "flashes then snaps back"
    // bug the mobile tile documents).
    setTheme(next)
    void save({ theme: next })
  }, [themeSetting, setTheme, save])
  const ThemeIcon =
    themeSetting === "light" ? SunIcon : themeSetting === "dark" ? MoonIcon : SunMoonIcon
  const themeLabel =
    themeSetting === "light"
      ? t("themeLight")
      : themeSetting === "dark"
        ? t("themeDark")
        : t("themeSystem")

  return (
    <div
      data-testid="sidebar-footer"
      className={cn("flex shrink-0 flex-col gap-px border-t px-2 py-1", className)}
    >
      {/* Icon strip, matching the declared `icon` form factor and the icon
          column's own footer (see `sidebar-nav-section.tsx`). */}
      <PluginExtensionSlot
        point="sidebar.left.bottom"
        className="flex flex-wrap items-center gap-1 pb-1 empty:hidden"
      />
      <div className="flex items-center gap-0.5">
        <SidebarUserCard className="min-w-0 flex-1" />
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={cycleTheme}
          aria-label={t("themeAria")}
          title={t("themeNow", { theme: themeLabel })}
          data-testid="sidebar-footer-theme"
        >
          <ThemeIcon className="size-4" aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => router.push("/settings")}
          aria-label={t("settings")}
          title={t("settings")}
          aria-keyshortcuts="Meta+Comma"
          data-testid="sidebar-footer-settings"
        >
          <SettingsIcon className="size-4" aria-hidden />
        </Button>
      </div>
      <SharedSessionJoin />
    </div>
  )
}
