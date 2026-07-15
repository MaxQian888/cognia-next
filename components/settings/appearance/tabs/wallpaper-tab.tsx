"use client"

// Wallpaper management panel, ordered the way the task actually runs: pick a
// wallpaper, then tune it.
//
//   1. enable switch (in the header — it gates the whole panel)
//   2. the gallery: built-ins + plugin + user-saved, with the two "add"
//      affordances as trailing "+" tiles rather than the two always-expanded
//      blocks they used to be. The grid itself is the drop target.
//   3. the adjustments (scope / position / blur / opacity), disabled until
//      something is actually selected to adjust.
//
// Persists everything via the appearance setters — no component-level state
// survives unmount.

import { useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { ImagePlusIcon, PaletteIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
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
import { intakeWallpaperFile } from "@/lib/appearance/wallpaper-intake"
import { wcagContrast } from "@/lib/appearance/contrast"
import type {
  BackgroundScope,
  Wallpaper,
  WallpaperPosition,
  WallpaperSource,
} from "@/types/appearance"
import { cn, responsiveSelectClass } from "@/lib/utils"
import { WallpaperCard } from "../components/wallpaper-card"
import { WallpaperUploader, type UploadedWallpaper } from "../components/wallpaper-uploader"
import { GradientBuilder } from "../components/gradient-builder"
import {
  listPluginWallpapers,
  subscribePluginWallpapers,
  type RegisteredPluginWallpaper,
} from "@/lib/plugin/bridge/wallpaper-bridge"

const POSITIONS: WallpaperPosition[] = ["cover", "contain", "tile", "center"]

// Stable identity for the SSR / pre-hydration snapshot — a fresh array each
// render would trip useSyncExternalStore's "snapshot should be cached" guard.
const EMPTY_PLUGIN_WALLPAPERS: RegisteredPluginWallpaper[] = []

interface ScopeCardSpec {
  scope: BackgroundScope
  labelKey: string
  descriptionKey: string
  highlight: { x: number; y: number; width: number; height: number }
}

// Layout: 100x60 viewBox represents the app shell.
//   sidebar at x=0..20, y=0..60     (left rail, full height)
//   main content at x=20..100, y=0..60
//   chat at x=20..80, y=0..60       (main except canvas)
//   canvas at x=80..100, y=0..60    (right side)
const SCOPE_CARDS: ScopeCardSpec[] = [
  {
    scope: "all",
    labelKey: "scope.all.label",
    descriptionKey: "scope.all.desc",
    highlight: { x: 0, y: 0, width: 100, height: 60 },
  },
  {
    scope: "global",
    labelKey: "scope.global.label",
    descriptionKey: "scope.global.desc",
    highlight: { x: 20, y: 0, width: 80, height: 60 },
  },
  {
    scope: "chat",
    labelKey: "scope.chat.label",
    descriptionKey: "scope.chat.desc",
    highlight: { x: 20, y: 0, width: 60, height: 60 },
  },
  {
    scope: "canvas",
    labelKey: "scope.canvas.label",
    descriptionKey: "scope.canvas.desc",
    highlight: { x: 80, y: 0, width: 20, height: 60 },
  },
  {
    scope: "sidebar",
    labelKey: "scope.sidebar.label",
    descriptionKey: "scope.sidebar.desc",
    highlight: { x: 0, y: 0, width: 20, height: 60 },
  },
]

function ScopeMockup({
  highlight,
  className,
}: {
  highlight: ScopeCardSpec["highlight"]
  className?: string
}) {
  return (
    <svg
      viewBox="0 0 100 60"
      className={cn("block rounded border border-border", className ?? "h-12 w-full")}
      aria-hidden="true"
    >
      <rect width="100" height="60" fill="var(--muted)" />
      <rect
        x={highlight.x}
        y={highlight.y}
        width={highlight.width}
        height={highlight.height}
        fill="var(--primary)"
        opacity="0.85"
      />
    </svg>
  )
}

// Hovering/focusing a scope control previews that region in the live app via
// a `<html>` attribute the background applier watches. Module-scope helpers so
// the four call sites below don't each re-do the SSR guard.
const BG_PREVIEW_ATTR = "data-bg-preview"

function setBgPreview(scope: BackgroundScope): void {
  if (typeof document === "undefined") return
  document.documentElement.setAttribute(BG_PREVIEW_ATTR, scope)
}

function clearBgPreview(): void {
  if (typeof document === "undefined") return
  document.documentElement.removeAttribute(BG_PREVIEW_ATTR)
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
  const [dragOver, setDragOver] = useState(false)

  // Plugin-contributed wallpapers (ADR-0029) live in an in-memory registry —
  // never in the user's settings row — so they merge into the gallery here
  // rather than being persisted. They carry `builtin: true`, so the delete
  // control is suppressed automatically (a plugin owns its own wallpapers).
  const pluginWallpapers = useSyncExternalStore(
    subscribePluginWallpapers,
    listPluginWallpapers,
    () => EMPTY_PLUGIN_WALLPAPERS
  )
  const gallery = useMemo(
    () => [...withBuiltinPresets(userWallpapers), ...pluginWallpapers],
    [userWallpapers, pluginWallpapers]
  )
  const pluginWallpaperIds = useMemo(
    () => new Set(pluginWallpapers.map((w) => w.id)),
    [pluginWallpapers]
  )
  const activeWallpaper = gallery.find((w) => w.id === background.activeId) ?? null
  const verdict = computeOpacityVerdict(activeWallpaper?.kind ?? null, background.opacity)
  // Nothing selected means nothing to tune — every adjustment below is inert.
  const hasActive = activeWallpaper !== null

  // The nav can unmount this panel mid-hover, which would pin a scope preview
  // onto <html> for the rest of the session.
  useEffect(() => clearBgPreview, [])

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

  // Dropping onto the gallery goes through the same intake as the picker.
  const handleDroppedFile = async (file: File) => {
    setBusyError(null)
    const result = await intakeWallpaperFile(file)
    if (!result.ok) {
      setBusyError(t(result.reason))
      return
    }
    await handleUpload(result.file)
  }

  return (
    <div className="space-y-4">
      {/* 1. Header — the master switch belongs with the title, not stacked
             above the controls it gates. */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label className="text-sm">{t("title")}</Label>
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

      {/* 2. Gallery first — you pick before you tune. The grid is the drop
             target, so there's no separate dropzone competing with it. */}
      <div
        data-testid="wallpaper-gallery-dropzone"
        data-drag-over={dragOver}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          const file = e.dataTransfer.files[0]
          if (file) void handleDroppedFile(file)
        }}
        className={cn(
          "space-y-2 rounded-lg border-2 border-dashed p-2 transition",
          dragOver ? "border-primary bg-primary/5" : "border-transparent"
        )}
      >
        <div className="flex items-baseline justify-between gap-2">
          <Label className="text-xs">{t("galleryTitle")}</Label>
          <span className="text-[10px] text-muted-foreground">{t("tiles.dropHint")}</span>
        </div>
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}
        >
          {gallery.map((wp) => {
            const card = (
              <WallpaperCard
                wallpaper={wp}
                active={background.activeId === wp.id}
                onActivate={() => void setActiveWallpaper(wp.id)}
                onDelete={!wp.builtin ? () => void handleDelete(wp) : undefined}
              />
            )
            if (!pluginWallpaperIds.has(wp.id)) {
              return <div key={wp.id}>{card}</div>
            }
            return (
              <div key={wp.id} className="relative">
                {card}
                <Badge
                  variant="secondary"
                  className="pointer-events-none absolute right-1 top-1 text-[10px]"
                >
                  {t("pluginBadge")}
                </Badge>
              </div>
            )
          })}

          {/* The two "add" affordances, as tiles rather than permanent blocks. */}
          <AddTile
            testId="wallpaper-add-upload"
            icon={<ImagePlusIcon className="size-5" />}
            label={t("tiles.upload")}
            ariaLabel={t("tiles.uploadAria")}
          >
            <WallpaperUploader onUpload={handleUpload} />
          </AddTile>
          <AddTile
            testId="wallpaper-add-gradient"
            icon={<PaletteIcon className="size-5" />}
            label={t("tiles.gradient")}
            ariaLabel={t("tiles.gradientAria")}
          >
            <GradientBuilder onCreate={handleGradient} />
          </AddTile>
        </div>
        {busyError && <p className="text-xs text-destructive">{busyError}</p>}
      </div>

      {/* 3. Adjustments — inert until there's something to adjust. `fieldset`
             only disables form controls, so the Radix sliders below take an
             explicit `disabled` too. */}
      <fieldset
        disabled={!hasActive}
        data-testid="wallpaper-adjustments"
        className={cn("space-y-4", !hasActive && "pointer-events-none opacity-50")}
      >
        {!hasActive && <p className="text-xs text-muted-foreground">{t("noActive")}</p>}

        <div className="space-y-1.5">
          <Label className="text-xs">{t("scopeLabel")}</Label>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t("scope.legend")}>
            {SCOPE_CARDS.map((card) => {
              const active = background.scope === card.scope
              return (
                <button
                  key={card.scope}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={t(card.labelKey)}
                  title={t(card.descriptionKey)}
                  data-active={active}
                  data-testid={`wallpaper-scope-${card.scope}`}
                  className={cn(
                    "flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs transition",
                    "data-[active=true]:border-primary data-[active=true]:bg-primary/5",
                    "hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  )}
                  onClick={() => void setBackground({ scope: card.scope })}
                  onMouseEnter={() => setBgPreview(card.scope)}
                  onMouseLeave={clearBgPreview}
                  onFocus={() => setBgPreview(card.scope)}
                  onBlur={clearBgPreview}
                >
                  <ScopeMockup highlight={card.highlight} className="h-4 w-7 shrink-0" />
                  {t(card.labelKey)}
                </button>
              )
            })}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label className="text-xs">{t("positionLabel")}</Label>
            <Select
              value={background.position}
              disabled={!hasActive}
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

          <div className="space-y-1.5">
            <Label className="text-xs">
              {t("blurLabel")} · {background.blurPx}px
            </Label>
            <Slider
              value={[background.blurPx]}
              min={0}
              max={32}
              step={1}
              disabled={!hasActive}
              onValueChange={(v) => void setBackground({ blurPx: v[0] ?? 0 })}
              aria-label={t("blurLabel")}
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">
              {t("opacityLabel")} · {Math.round(background.opacity * 100)}%
            </Label>
            <Slider
              value={[Math.round(background.opacity * 100)]}
              min={0}
              max={100}
              step={1}
              disabled={!hasActive}
              onValueChange={(v) => void setBackground({ opacity: (v[0] ?? 0) / 100 })}
              aria-label={t("opacityLabel")}
            />
          </div>
        </div>

        {verdict && (
          <div className="flex flex-wrap items-center gap-2">
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
      </fieldset>
    </div>
  )
}

/** A gallery tile that opens an "add wallpaper" surface in a popover. */
function AddTile({
  testId,
  icon,
  label,
  ariaLabel,
  children,
}: {
  testId: string
  icon: React.ReactNode
  label: string
  ariaLabel: string
  children: React.ReactNode
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          data-testid={testId}
          className={cn(
            "flex aspect-video flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed",
            "text-muted-foreground transition hover:border-primary hover:text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          )}
        >
          {icon}
          <span className="text-[11px]">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80">{children}</PopoverContent>
    </Popover>
  )
}
