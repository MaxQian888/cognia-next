"use client"

/**
 * 4-tile quick-action grid for the mobile profile screen.
 *
 *   ┌──────┬──────┬──────┬──────┐
 *   │ 主题 │ 语言 │ CU   │ 扫码 │
 *   └──────┴──────┴──────┴──────┘
 *
 * - Theme tile cycles Light → Dark → Auto (next-themes write).
 * - Language tile cycles en ↔ zh-CN (`useSettingsStore.setLanguage`).
 * - Computer Use tile toggles the master switch
 *   (`mobileComputerUseEnabled` — new field in AppSettings).
 * - Scan tile opens the existing `<MobileServerScanSheet>` so the user
 *   can re-pair without leaving the profile screen.
 *
 * Replaces the legacy `<QuickToggles>` (2 buttons; preserves its theme
 * and language semantics so anything depending on `quick-theme-toggle` /
 * `quick-language-toggle` testids continues to work).
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useTheme } from "next-themes"
import {
  LanguagesIcon,
  MonitorIcon,
  MoonIcon,
  QrCodeIcon,
  SunIcon,
  SunMoonIcon,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { MobileServerScanSheet } from "@/components/mobile/connection-state-sheets/mobile-server-scan-sheet"
import { selectionFeedback } from "@/lib/capacitor/haptics"
import { useSettingsStore } from "@/stores/settings"
import { cn } from "@/lib/utils"
import type { AppLanguage, AppTheme } from "@/lib/claude/types"

const THEME_CYCLE: AppTheme[] = ["system", "light", "dark"]
const LANGUAGE_CYCLE: AppLanguage[] = ["en", "zh-CN"]

const LANGUAGE_LABEL: Record<AppLanguage, string> = {
  en: "EN",
  "zh-CN": "中文",
}

function Tile({
  icon: Icon,
  label,
  value,
  onClick,
  active,
  ariaLabel,
  testid,
}: {
  icon: LucideIcon
  label: string
  value?: string
  onClick: () => void
  active?: boolean
  ariaLabel: string
  testid: string
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onClick}
      aria-label={ariaLabel}
      data-testid={testid}
      className={cn(
        "h-auto flex-1 flex-col items-center gap-1 px-2 py-3",
        active && "border-primary/60 bg-primary/5"
      )}
    >
      <div className="relative flex items-center justify-center">
        <Icon className="size-4" aria-hidden="true" />
        {active ? (
          <span
            aria-hidden="true"
            className="absolute -right-2 -top-1 size-1.5 rounded-full bg-primary"
          />
        ) : null}
      </div>
      <span className="text-[11px] font-medium leading-tight text-center">{label}</span>
      {value ? <span className="text-[10px] text-muted-foreground">{value}</span> : null}
    </Button>
  )
}

export interface QuickActionGridProps {
  className?: string
}

export function QuickActionGrid({ className }: QuickActionGridProps) {
  const t = useTranslations("mobile.me.quickToggles")
  const tCu = useTranslations("mobile.me.quickActions")
  const { theme, setTheme } = useTheme()
  const language = useSettingsStore((s) => s.language)
  const setLanguage = useSettingsStore((s) => s.setLanguage)
  const computerUseEnabled = useSettingsStore((s) => s.settings?.mobileComputerUseEnabled ?? false)
  const save = useSettingsStore((s) => s.save)
  const [scanOpen, setScanOpen] = useState(false)

  const currentTheme: AppTheme =
    theme === "light" || theme === "dark" || theme === "system" ? theme : "system"
  const themeLabel =
    currentTheme === "light"
      ? t("themeLight")
      : currentTheme === "dark"
        ? t("themeDark")
        : t("themeAuto")
  const ThemeIcon =
    currentTheme === "light" ? SunIcon : currentTheme === "dark" ? MoonIcon : SunMoonIcon

  const cycleTheme = () => {
    const idx = THEME_CYCLE.indexOf(currentTheme)
    const next = THEME_CYCLE[(idx + 1) % THEME_CYCLE.length]
    setTheme(next)
    void selectionFeedback()
  }

  const cycleLanguage = () => {
    const idx = LANGUAGE_CYCLE.indexOf(language)
    const next = LANGUAGE_CYCLE[(idx + 1) % LANGUAGE_CYCLE.length]
    void setLanguage(next)
    void selectionFeedback()
  }

  const toggleComputerUse = () => {
    void save({ mobileComputerUseEnabled: !computerUseEnabled })
    void selectionFeedback()
  }

  const openScan = () => {
    setScanOpen(true)
    void selectionFeedback()
  }

  return (
    <>
      <div className={cn("flex items-center gap-2", className)} data-testid="quick-action-grid">
        <Tile
          icon={ThemeIcon}
          label={t("themeAria")}
          value={themeLabel}
          onClick={cycleTheme}
          ariaLabel={t("themeAria")}
          testid="quick-theme-toggle"
        />
        <Tile
          icon={LanguagesIcon}
          label={t("languageAria")}
          value={LANGUAGE_LABEL[language]}
          onClick={cycleLanguage}
          ariaLabel={t("languageAria")}
          testid="quick-language-toggle"
        />
        <Tile
          icon={MonitorIcon}
          label={tCu("computerUseLabel")}
          value={computerUseEnabled ? tCu("on") : tCu("off")}
          onClick={toggleComputerUse}
          active={computerUseEnabled}
          ariaLabel={tCu("computerUseAria")}
          testid="quick-computer-use-toggle"
        />
        <Tile
          icon={QrCodeIcon}
          label={tCu("scanLabel")}
          onClick={openScan}
          ariaLabel={tCu("scanAria")}
          testid="quick-scan-pair"
        />
      </div>
      <MobileServerScanSheet open={scanOpen} onOpenChange={setScanOpen} />
    </>
  )
}
