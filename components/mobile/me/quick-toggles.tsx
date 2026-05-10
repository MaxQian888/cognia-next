"use client"

import { useTranslations } from "next-intl"
import { useTheme } from "next-themes"
import { LanguagesIcon, MoonIcon, SunIcon, SunMoonIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
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

export interface QuickTogglesProps {
  className?: string
}

export function QuickToggles({ className }: QuickTogglesProps) {
  const t = useTranslations("mobile.me.quickToggles")
  const { theme, setTheme } = useTheme()
  const language = useSettingsStore((s) => s.language)
  const setLanguage = useSettingsStore((s) => s.setLanguage)

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

  return (
    <div className={cn("flex items-center gap-2", className)} data-testid="quick-toggles">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={cycleTheme}
        aria-label={t("themeAria")}
        data-testid="quick-theme-toggle"
        data-theme={currentTheme}
        className="flex-1 gap-2"
      >
        <ThemeIcon className="size-4" aria-hidden="true" />
        <span className="text-xs">{themeLabel}</span>
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={cycleLanguage}
        aria-label={t("languageAria")}
        data-testid="quick-language-toggle"
        data-language={language}
        className="flex-1 gap-2"
      >
        <LanguagesIcon className="size-4" aria-hidden="true" />
        <span className="text-xs">{LANGUAGE_LABEL[language]}</span>
      </Button>
    </div>
  )
}
