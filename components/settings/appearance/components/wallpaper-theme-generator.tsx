"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2Icon, SparklesIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useSettingsStore } from "@/stores/settings"
import {
  analyzeWallpaperSource,
  buildWallpaperTheme,
  type WallpaperThemeAnalysis,
} from "@/lib/appearance/wallpaper-theme-generator"
import type { Wallpaper } from "@/types/appearance"

export interface WallpaperThemeGeneratorProps {
  wallpaper: Wallpaper | null
}

/** Generate and activate a Cognia color theme from the selected image wallpaper. */
export function WallpaperThemeGenerator({ wallpaper }: WallpaperThemeGeneratorProps) {
  const t = useTranslations("settings.appearance.wallpaper.generator")
  const createCustomTheme = useSettingsStore((state) => state.createCustomTheme)
  const setActiveCustomTheme = useSettingsStore((state) => state.setActiveCustomTheme)
  const [busy, setBusy] = useState(false)
  const [analysis, setAnalysis] = useState<WallpaperThemeAnalysis | null>(null)
  const [failed, setFailed] = useState(false)

  if (!wallpaper || wallpaper.source.kind !== "image") return null
  const source = wallpaper.source

  const generate = async () => {
    setBusy(true)
    setFailed(false)
    try {
      const nextAnalysis = await analyzeWallpaperSource(source)
      const theme = buildWallpaperTheme(t("themeName", { name: wallpaper.name }), nextAnalysis)
      const id = createCustomTheme(theme)
      setActiveCustomTheme(id)
      setAnalysis(nextAnalysis)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="flex flex-col gap-3 rounded-lg border bg-card/60 p-3 sm:flex-row sm:items-center"
      data-testid="wallpaper-theme-generator"
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <SparklesIcon className="size-4 text-primary" aria-hidden />
          <p className="text-sm font-medium">{t("title")}</p>
          {analysis && (
            <>
              <span
                className="size-4 rounded-full border"
                style={{ backgroundColor: analysis.accent }}
                aria-label={t("accent")}
              />
              <Badge variant="secondary" className="text-[10px]">
                {t(`variant.${analysis.baseVariant}`)}
              </Badge>
            </>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {analysis ? t("created") : t("description")}
        </p>
        {failed && <p className="text-xs text-destructive">{t("error")}</p>}
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="shrink-0 gap-1.5"
        disabled={busy}
        onClick={() => void generate()}
      >
        {busy ? <Loader2Icon className="size-3.5 animate-spin" aria-hidden /> : null}
        {t("action")}
      </Button>
    </div>
  )
}
