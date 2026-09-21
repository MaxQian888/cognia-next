"use client"

// Derives a Cognia color theme — and a readable opacity/blur — from whatever
// wallpaper is active. Works for every wallpaper kind: images go through a
// canvas sample, gradients and solid colors through their declared color
// stops, so the built-in gradient presets (the bulk of the gallery) are no
// longer excluded from the feature.
//
// The analysis runs on mount rather than on click. It is the input to the
// readability chip in `wallpaper-tab.tsx`, which without it can only assume a
// worst-case image — so "select a wallpaper, see an honest contrast number"
// needs the sample to already exist.
//
// The single action button does the WHOLE job — users reasonably assume
// "generate" finishes adapting the wallpaper, so it creates (or refreshes)
// and activates the theme AND applies the suggested opacity/blur in the same
// click. The separate "apply suggested values" row below only resurfaces
// when the live sliders have drifted away from the suggestion, as a way to
// snap them back — not as a second required step.

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
  /**
   * The opacity/blur the background currently runs at. Lets the suggestion
   * row hide itself once the values match — and reappear when the user drags
   * the sliders away again.
   */
  currentTuning?: WallpaperTuning
}

export function WallpaperThemeGenerator({
  wallpaper,
  onAnalyzed,
  onApplyTuning,
  currentTuning,
}: WallpaperThemeGeneratorProps) {
  const t = useTranslations("settings.appearance.wallpaper.generator")
  const createCustomTheme = useSettingsStore((state) => state.createCustomTheme)
  const updateCustomTheme = useSettingsStore((state) => state.updateCustomTheme)
  const setActiveCustomTheme = useSettingsStore((state) => state.setActiveCustomTheme)
  const customThemes = useSettingsStore((state) => state.customThemes)
  const activeCustomThemeId = useSettingsStore((state) => state.activeCustomThemeId)
  const [busy, setBusy] = useState(false)
  const [analysis, setAnalysis] = useState<WallpaperThemeAnalysis | null>(null)
  // null = nothing generated yet; otherwise whether the suggested
  // opacity/blur went on with the theme — the status line reports both.
  const [outcome, setOutcome] = useState<{ tuningApplied: boolean } | null>(null)
  const [failed, setFailed] = useState(false)
  // Snapshot of `currentTuning` taken the moment a suggestion was applied.
  // The store write lands asynchronously; until the props catch up the row
  // would briefly re-show as "values differ". While they still equal the
  // pre-apply snapshot, keep it hidden.
  const [tuningShadow, setTuningShadow] = useState<WallpaperTuning | null>(null)

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

  const applySuggestedTuning = useCallback(
    (next: WallpaperTuning) => {
      setTuningShadow(currentTuning ?? null)
      onApplyTuning?.(next)
    },
    [currentTuning, onApplyTuning]
  )

  const generate = useCallback(async () => {
    if (!wallpaper) return
    setBusy(true)
    setFailed(false)
    try {
      // Re-sample rather than trusting the mount-time analysis: a plugin can
      // swap the bytes behind a wallpaper id while this panel is open.
      const nextAnalysis = await analyzeWallpaperSource(wallpaper.source)
      const theme = buildWallpaperTheme(t("themeName", { name: wallpaper.name }), nextAnalysis)
      // Generating again on the same wallpaper refreshes the row it made last
      // time instead of stacking a duplicate into the theme list.
      const existing = customThemes.find((candidate) => candidate.name === theme.name)
      let themeId: string
      if (existing) {
        // updateCustomTheme merges — clear the fields a generated row never
        // sets so provenance/extra-CSS from an unrelated same-named row can't
        // linger. `ownerPluginId` stays: it is lifecycle ownership, not paint.
        updateCustomTheme(existing.id, {
          ...theme,
          derivedVariant: undefined,
          cssVars: undefined,
          sourcePluginId: undefined,
          sourceBuiltinName: undefined,
        })
        themeId = existing.id
      } else {
        themeId = createCustomTheme(theme)
      }
      // Re-activating the same theme would only rewrite the row unchanged.
      if (activeCustomThemeId !== themeId) {
        setActiveCustomTheme(themeId)
      }
      setAnalysis(nextAnalysis)
      onAnalyzedRef.current?.(nextAnalysis)
      // One click completes the adaptation: the suggested readability values
      // go on alongside the theme. Skipped when the sliders already sit at
      // the suggestion — an identical write would just dirty the row.
      const suggested = recommendBackgroundTuning(nextAnalysis, wallpaper.kind)
      const tuningDiffers =
        !currentTuning ||
        currentTuning.opacity !== suggested.opacity ||
        currentTuning.blurPx !== suggested.blurPx
      const tuningApplied = Boolean(onApplyTuning && tuningDiffers)
      if (onApplyTuning && tuningDiffers) {
        applySuggestedTuning(suggested)
      }
      setOutcome({ tuningApplied })
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }, [
    wallpaper,
    t,
    customThemes,
    activeCustomThemeId,
    createCustomTheme,
    updateCustomTheme,
    setActiveCustomTheme,
    onApplyTuning,
    currentTuning,
    applySuggestedTuning,
  ])

  if (!wallpaper) return null

  const tuning = analysis ? recommendBackgroundTuning(analysis, wallpaper.kind) : null
  const tuningDiffers =
    !currentTuning ||
    (tuning !== null &&
      (currentTuning.opacity !== tuning.opacity || currentTuning.blurPx !== tuning.blurPx))
  const tuningShadowed =
    tuningShadow !== null &&
    currentTuning !== undefined &&
    currentTuning.opacity === tuningShadow.opacity &&
    currentTuning.blurPx === tuningShadow.blurPx
  const showTuning =
    tuning !== null && onApplyTuning !== undefined && tuningDiffers && !tuningShadowed

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
            {outcome
              ? outcome.tuningApplied
                ? t("createdWithTuning")
                : t("created")
              : t("description")}
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

      {/* Not a second required step — the generate button already applied the
          suggestion. This row only resurfaces when the live sliders drift
          away from it, offering a way to snap back. */}
      {showTuning && tuning && (
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
            onClick={() => applySuggestedTuning(tuning)}
          >
            <WandSparklesIcon className="size-3.5" aria-hidden />
            {t("applyTuning")}
          </Button>
        </div>
      )}
    </div>
  )
}
