"use client"

// Derives a Cognia color theme — and a readable opacity/blur — from whatever
// wallpaper is active. Works for every wallpaper kind: images go through a
// canvas sample, gradients and solid colors through their declared color stops,
// so the built-in gradient presets (the bulk of the gallery) are no longer
// excluded from the feature.
//
// The analysis runs on mount rather than on click. It is the input to the
// readability chip in `wallpaper-tab.tsx`, which without it can only assume a
// worst-case image — so "select a wallpaper, see an honest contrast number"
// needs the sample to already exist. Generating and activating a theme stays an
// explicit action.

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2Icon, SparklesIcon, WandSparklesIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useSettingsStore } from "@/stores/settings"
import {
  analyzeWallpaperSource,
  buildWallpaperTheme,
  recommendBackgroundTuning,
  type WallpaperThemeAnalysis,
} from "@/lib/appearance/wallpaper-theme-generator"
import type { Wallpaper } from "@/types/appearance"

export interface WallpaperTuning {
  opacity: number
  blurPx: number
}

export interface WallpaperThemeGeneratorProps {
  wallpaper: Wallpaper | null
  /**
   * Reports each fresh sample (or null when sampling failed) so the readability
   * chip can measure the real wallpaper instead of guessing.
   */
  onAnalyzed?: (analysis: WallpaperThemeAnalysis | null) => void
  /** Applies the sample-derived opacity/blur to the live background. */
  onApplyTuning?: (tuning: WallpaperTuning) => void
}

export function WallpaperThemeGenerator({
  wallpaper,
  onAnalyzed,
  onApplyTuning,
}: WallpaperThemeGeneratorProps) {
  const t = useTranslations("settings.appearance.wallpaper.generator")
  const createCustomTheme = useSettingsStore((state) => state.createCustomTheme)
  const setActiveCustomTheme = useSettingsStore((state) => state.setActiveCustomTheme)
  const [busy, setBusy] = useState(false)
  const [analysis, setAnalysis] = useState<WallpaperThemeAnalysis | null>(null)
  const [applied, setApplied] = useState(false)
  const [failed, setFailed] = useState(false)

  // Keep the reporting callback out of the sampling effect's dependency list —
  // an inline arrow from the parent would otherwise re-sample every render.
  const onAnalyzedRef = useRef(onAnalyzed)
  useEffect(() => {
    onAnalyzedRef.current = onAnalyzed
  }, [onAnalyzed])

  const source = wallpaper?.source ?? null

  // Deliberately does not touch `busy`: that flag belongs to the explicit
  // generate action, and flipping it here would both trip the
  // set-state-in-effect rule and disable the button during a sample the user
  // never asked for.
  useEffect(() => {
    if (!source) return
    let cancelled = false
    analyzeWallpaperSource(source)
      .then((next) => {
        if (cancelled) return
        setAnalysis(next)
        setFailed(false)
        onAnalyzedRef.current?.(next)
      })
      .catch(() => {
        if (cancelled) return
        setAnalysis(null)
        setFailed(true)
        onAnalyzedRef.current?.(null)
      })
    return () => {
      cancelled = true
    }
  }, [source])

  const generate = useCallback(async () => {
    if (!wallpaper) return
    setBusy(true)
    setFailed(false)
    try {
      // Re-sample rather than trusting the mount-time analysis: a plugin can
      // swap the bytes behind a wallpaper id while this panel is open.
      const nextAnalysis = await analyzeWallpaperSource(wallpaper.source)
      const theme = buildWallpaperTheme(t("themeName", { name: wallpaper.name }), nextAnalysis)
      const id = createCustomTheme(theme)
      setActiveCustomTheme(id)
      setAnalysis(nextAnalysis)
      setApplied(true)
      onAnalyzedRef.current?.(nextAnalysis)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }, [wallpaper, t, createCustomTheme, setActiveCustomTheme])

  if (!wallpaper) return null

  const tuning = analysis ? recommendBackgroundTuning(analysis, wallpaper.kind) : null

  return (
    <div
      className="space-y-3 rounded-lg border bg-card/60 p-3"
      data-testid="wallpaper-theme-generator"
    >
      <div className="flex flex-col gap-3 @md/appearance-pane:flex-row @md/appearance-pane:items-center">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <SparklesIcon className="size-4 text-primary" aria-hidden />
            <p className="text-sm font-medium">{t("title")}</p>
            {analysis && (
              <>
                <span
                  className="size-4 rounded-full border"
                  style={{ backgroundColor: analysis.accent }}
                  aria-label={t("accent")}
                  data-testid="wallpaper-accent-swatch"
                />
                <span
                  className="size-4 rounded-full border"
                  style={{ backgroundColor: analysis.secondary }}
                  aria-label={t("secondary")}
                  data-testid="wallpaper-secondary-swatch"
                />
                <Badge variant="secondary" className="text-[10px]">
                  {t(`variant.${analysis.baseVariant}`)}
                </Badge>
              </>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {applied ? t("created") : t("description")}
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

      {/* The other half of "adapt to this wallpaper": a busy image needs less
          opacity and more blur than a flat gradient, and the sample already
          knows which one this is. */}
      {tuning && onApplyTuning && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">
            {t("tuningHint", {
              opacity: Math.round(tuning.opacity * 100),
              blur: tuning.blurPx,
            })}
          </p>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="shrink-0 gap-1.5"
            data-testid="wallpaper-apply-tuning"
            onClick={() => onApplyTuning(tuning)}
          >
            <WandSparklesIcon className="size-3.5" aria-hidden />
            {t("applyTuning")}
          </Button>
        </div>
      )}
    </div>
  )
}
