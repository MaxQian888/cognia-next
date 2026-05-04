"use client"

// Wallpaper management tab. Combines:
//   - the gallery (built-ins + user-saved) with active selection
//   - the upload + gradient builder
//   - the per-background controls (scope / blur / opacity / position)
// Persists everything via the appearance setters added in P1 — no
// component-level state survives unmount.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { useSettingsStore } from "@/stores/settings"
import { withBuiltinPresets, saveImage, deleteImage, makeWallpaper } from "@/lib/appearance"
import { wcagContrast } from "@/lib/appearance/contrast"
import type {
  BackgroundScope,
  Wallpaper,
  WallpaperPosition,
  WallpaperSource,
} from "@/types/appearance"
import { responsiveSelectClass } from "@/lib/utils"
import { WallpaperCard } from "../components/wallpaper-card"
import { WallpaperUploader, type UploadedWallpaper } from "../components/wallpaper-uploader"
import { GradientBuilder } from "../components/gradient-builder"

const SCOPES: BackgroundScope[] = ["all", "global", "chat", "canvas", "sidebar"]
const POSITIONS: WallpaperPosition[] = ["cover", "contain", "tile", "center"]

const SCOPE_LABEL_KEY: Record<BackgroundScope, string> = {
  all: "scopeAll",
  global: "scopeGlobal",
  chat: "scopeChat",
  canvas: "scopeCanvas",
  sidebar: "scopeSidebar",
}

const POSITION_LABEL_KEY: Record<WallpaperPosition, string> = {
  cover: "positionCover",
  contain: "positionContain",
  tile: "positionTile",
  center: "positionCenter",
}

function nanoId(): string {
  return `wp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Model the contrast loss caused by the wallpaper layer. Image-kind wallpapers
 * are treated as worst-case noise (asymptote toward 1.5:1 at full opacity)
 * because we don't sample dominant colours at runtime; gradient/colour
 * wallpapers get a gentler half-strength penalty since their tone is at least
 * mostly uniform.
 */
export function effectiveContrast(staticRatio: number, opacity: number, isImage: boolean): number {
  const clamped = Math.max(0, Math.min(1, opacity))
  if (isImage) {
    const worst = 1.5
    return staticRatio * (1 - clamped) + worst * clamped
  }
  return staticRatio * (1 - clamped * 0.5)
}

function bandRatio(ratio: number): "ok" | "warn" | "fail" {
  if (ratio >= 4.5) return "ok"
  if (ratio >= 3) return "warn"
  return "fail"
}

/**
 * Compute the live readability verdict for the wallpaper opacity guard. Reads
 * `--foreground` and `--background` from `<html>` directly because the
 * effective text colour depends on the active theme, which lives in CSS-only
 * state. Returns null on SSR.
 */
export function computeOpacityVerdict(
  activeKind: "image" | "gradient" | "color" | null,
  opacity: number
): { level: "ok" | "warn" | "fail"; ratio: number } | null {
  if (typeof window === "undefined") return null
  const cs = getComputedStyle(document.documentElement)
  const fg = cs.getPropertyValue("--foreground").trim() || "#000000"
  const bg = cs.getPropertyValue("--background").trim() || "#ffffff"
  let baseRatio: number
  try {
    baseRatio = wcagContrast(fg, bg)
  } catch {
    // culori may not parse a CSS variable that resolves to e.g. "oklch(...)"
    // in some test environments; fall back to a high static ratio so we
    // don't flash a fail chip when the theme itself is fine.
    baseRatio = 21
  }
  const ratio = effectiveContrast(baseRatio, opacity, activeKind === "image")
  return { level: bandRatio(ratio), ratio }
}

export function WallpaperTab() {
  const t = useTranslations("settings.appearance.wallpaper")

  const background = useSettingsStore((s) => s.background)
  const userWallpapers = useSettingsStore((s) => s.wallpapers)
  const setBackground = useSettingsStore((s) => s.setBackground)
  const addWallpaper = useSettingsStore((s) => s.addWallpaper)
  const deleteWallpaperRow = useSettingsStore((s) => s.deleteWallpaper)
  const setActiveWallpaper = useSettingsStore((s) => s.setActiveWallpaper)
  const [busyError, setBusyError] = useState<string | null>(null)

  const gallery = withBuiltinPresets(userWallpapers)
  const activeWallpaper = gallery.find((w) => w.id === background.activeId) ?? null
  const verdict = computeOpacityVerdict(activeWallpaper?.kind ?? null, background.opacity)

  const handleUpload = async (file: UploadedWallpaper) => {
    try {
      const id = nanoId()
      const saved = await saveImage({
        id,
        bytes: file.bytes,
        mime: file.mime,
        width: file.width,
        height: file.height,
      })
      const row = makeWallpaper({
        id,
        name: file.fileName.replace(/\.[^.]+$/, ""),
        source: saved.source as WallpaperSource,
      })
      await addWallpaper(row)
      // Activating immediately is a nicer UX than making the user click
      // twice — they just dropped a file because they want to see it.
      await setActiveWallpaper(id)
    } catch (err) {
      setBusyError((err as Error).message)
    }
  }

  const handleGradient = async (css: string, name: string) => {
    const id = nanoId()
    const row = makeWallpaper({
      id,
      name,
      source: { kind: "gradient", css },
    })
    await addWallpaper(row)
    await setActiveWallpaper(id)
  }

  const handleDelete = async (wp: Wallpaper) => {
    // Order matters: file first (idempotent), then DB row.
    await deleteImage(wp.source)
    await deleteWallpaperRow(wp.id)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label className="text-sm">{t("enabledLabel")}</Label>
          <p className="text-xs text-muted-foreground">{t("description")}</p>
        </div>
        <Switch
          checked={background.enabled}
          onCheckedChange={(checked) => {
            void setBackground({ enabled: checked })
          }}
          aria-label={t("enabledLabel")}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label className="text-xs">{t("scopeLabel")}</Label>
          <Select
            value={background.scope}
            onValueChange={(v) => void setBackground({ scope: v as BackgroundScope })}
          >
            <SelectTrigger className={responsiveSelectClass}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCOPES.map((s) => (
                <SelectItem key={s} value={s}>
                  {t(SCOPE_LABEL_KEY[s])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label className="text-xs">{t("positionLabel")}</Label>
          <Select
            value={background.position}
            onValueChange={(v) => void setBackground({ position: v as WallpaperPosition })}
          >
            <SelectTrigger className={responsiveSelectClass}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {POSITIONS.map((p) => (
                <SelectItem key={p} value={p}>
                  {t(POSITION_LABEL_KEY[p])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label className="text-xs">
            {t("blurLabel")} · {background.blurPx}px
          </Label>
          <Slider
            value={[background.blurPx]}
            min={0}
            max={32}
            step={1}
            onValueChange={(v) => void setBackground({ blurPx: v[0] ?? 0 })}
            aria-label={t("blurLabel")}
          />
        </div>

        <div className="space-y-2">
          <Label className="text-xs">
            {t("opacityLabel")} · {Math.round(background.opacity * 100)}%
          </Label>
          <Slider
            value={[Math.round(background.opacity * 100)]}
            min={0}
            max={100}
            step={1}
            onValueChange={(v) => void setBackground({ opacity: (v[0] ?? 0) / 100 })}
            aria-label={t("opacityLabel")}
          />
          {verdict && (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Badge
                variant={
                  verdict.level === "ok"
                    ? "default"
                    : verdict.level === "warn"
                      ? "outline"
                      : "destructive"
                }
                aria-label={t("opacity.contrastLabel")}
                data-testid="wallpaper-contrast-chip"
              >
                {verdict.level.toUpperCase()} {verdict.ratio.toFixed(1)}:1
              </Badge>
              {verdict.level !== "ok" && (
                <span className="text-xs text-muted-foreground">
                  {verdict.level === "warn" ? t("opacity.warn") : t("opacity.fail")}
                </span>
              )}
              {verdict.level === "fail" && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void setBackground({ opacity: 0.4 })
                  }}
                >
                  {t("opacity.autoFix")}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <Label className="text-xs">{t("galleryTitle")}</Label>
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}
        >
          {gallery.map((wp) => (
            <WallpaperCard
              key={wp.id}
              wallpaper={wp}
              active={background.activeId === wp.id}
              onActivate={() => void setActiveWallpaper(wp.id)}
              onDelete={!wp.builtin ? () => void handleDelete(wp) : undefined}
            />
          ))}
        </div>
      </div>

      <WallpaperUploader onUpload={handleUpload} />
      {busyError && <p className="text-xs text-destructive">{busyError}</p>}

      <div className="space-y-2">
        <Label className="text-xs">{t("gradient.title")}</Label>
        <GradientBuilder onCreate={handleGradient} />
      </div>
    </div>
  )
}
