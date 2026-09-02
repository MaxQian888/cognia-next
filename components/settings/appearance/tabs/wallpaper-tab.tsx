"use client"

// Wallpaper management panel, ordered the way the task actually runs: pick a
// wallpaper, then tune it.
//
//   1. enable switch (in the header — it gates the whole panel)
//   2. the gallery: built-ins + plugin + user-saved, with the two "add"
//      affordances as trailing "+" tiles rather than the two always-expanded
//      blocks they used to be. The grid itself is the drop target.
//   3. the adjustments, disabled until something is actually selected to
//      adjust, and split into the two questions they answer:
//        · Placement — where the image goes (scope, fit, focal point)
//        · Readability — what it does to text (blur, opacity, contrast)
//   4. the sampler, which feeds both the generated theme and the honest
//      contrast reading in (3).
//
// Persists everything via the appearance setters. The only local state is the
// in-flight slider drag: committing every pointer move would write Dexie a
// hundred times per gesture, so the drag paints the live CSS variables directly
// and only the released value is persisted.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
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
import {
  BG_VARS,
  FOCAL_PRESETS,
  WALLPAPER_POSITIONS,
  clampFocal,
  focalPresetId,
  supportsFocalPoint,
} from "@/lib/appearance/background-fit"
import { computeOpacityVerdict } from "@/lib/appearance/wallpaper-readability"
import type { WallpaperThemeAnalysis } from "@/lib/appearance/wallpaper-theme-generator"
import type {
  BackgroundScope,
  Wallpaper,
  WallpaperPosition,
  WallpaperSource,
} from "@/types/appearance"
import {
  DEFAULT_WALLPAPER_ROTATION,
  type WallpaperRotationSettings,
} from "@/types/appearance/wallpaper-rotation"
import { cn, responsiveSelectClass } from "@/lib/utils"
import { WallpaperCard } from "../components/wallpaper-card"
import { WallpaperUploader, type UploadedWallpaper } from "../components/wallpaper-uploader"
import {
  WallpaperThemeGenerator,
  type WallpaperTuning,
} from "../components/wallpaper-theme-generator"
import { GradientBuilder } from "../components/gradient-builder"
import { WallpaperRotationCard } from "../components/wallpaper-rotation-card"
import {
  listPluginWallpapers,
  subscribePluginWallpapers,
  type RegisteredPluginWallpaper,
} from "@/lib/plugin/bridge/wallpaper-bridge"

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
  className: string
}) {
  return (
    <svg
      viewBox="0 0 100 60"
      className={cn("block rounded border border-border", className)}
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
// the call sites below don't each re-do the SSR guard.
const BG_PREVIEW_ATTR = "data-bg-preview"

function setBgPreview(scope: BackgroundScope): void {
  if (typeof document === "undefined") return
  document.documentElement.setAttribute(BG_PREVIEW_ATTR, scope)
}

function clearBgPreview(): void {
  if (typeof document === "undefined") return
  document.documentElement.removeAttribute(BG_PREVIEW_ATTR)
}

/** Paint a wallpaper CSS variable without persisting — used during a drag. */
function previewBackgroundVar(name: string, value: string): void {
  if (typeof document === "undefined") return
  document.body.style.setProperty(name, value)
}

const POSITION_LABEL_KEY: Record<WallpaperPosition, string> = {
  cover: "positionCover",
  contain: "positionContain",
  fill: "positionFill",
  tile: "positionTile",
  center: "positionCenter",
}

/** Arrow keys that move focus inside the scope radiogroup, and by how much. */
const ROVING_KEYS: Record<string, number> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
}

/**
 * Radix emits one entry per thumb and these sliders have exactly one, so the
 * read is asserted rather than defaulted — a fallback here would be an
 * unreachable branch fired on every pointer move.
 */
function sliderValue(values: number[]): number {
  return values[0]!
}

function nanoId(): string {
  return `wp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
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
  // Tagged with the wallpaper it came from: switching wallpapers must not let
  // the readability chip keep reporting the previous image's measurement while
  // the new sample is still in flight.
  const [analysis, setAnalysis] = useState<{
    id: string
    value: WallpaperThemeAnalysis | null
  } | null>(null)
  // In-flight slider value. Null between gestures, so the persisted value wins.
  const [drag, setDrag] = useState<{ key: "opacity" | "blurPx"; value: number } | null>(null)

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
  // Nothing selected means nothing to tune — every adjustment below is inert.
  const hasActive = activeWallpaper !== null

  const opacity = drag?.key === "opacity" ? drag.value : background.opacity
  const blurPx = drag?.key === "blurPx" ? drag.value : background.blurPx
  const focalX = clampFocal(background.focalX)
  const focalY = clampFocal(background.focalY)
  const focalEnabled = supportsFocalPoint(background.position)
  const activeFocalPreset = focalPresetId(focalX, focalY)

  const rotation: WallpaperRotationSettings = {
    ...DEFAULT_WALLPAPER_ROTATION,
    ...(background.rotation ?? {}),
  }
  // Mirrors the applier's own rule. The card needs it because a live scrim
  // downgrades the transition, and the user should be told that where they
  // pick it rather than discovering it by watching.
  const scrimActive = activeWallpaper?.kind === "image" && opacity < 0.5

  // Deliberately not memoised. `rotation` is rebuilt every render from the
  // store, so a `useCallback` over it would be re-created every render anyway,
  // and reading the ref instead would make the ref a hook argument the React
  // compiler then refuses to let the effect below reassign.
  const handleRotationChange = (patch: Partial<WallpaperRotationSettings>) => {
    void setBackground({ rotation: { ...rotation, ...patch } })
  }

  const activeAnalysis = analysis?.id === activeWallpaper?.id ? (analysis?.value ?? null) : null
  const verdict = computeOpacityVerdict({
    kind: activeWallpaper?.kind ?? null,
    opacity,
    analysis: activeAnalysis,
  })
  const suggestedOpacity = verdict?.suggestedOpacity ?? null

  // The nav can unmount this panel mid-hover, which would pin a scope preview
  // onto <html> for the rest of the session.
  useEffect(() => clearBgPreview, [])

  // Same hazard for the live-preview variables: unmounting mid-drag would leave
  // the wallpaper stuck at a value that was never persisted. Restore whatever
  // the store actually holds on the way out.
  const persistedRef = useRef(background)
  useEffect(() => {
    persistedRef.current = background
  }, [background])
  useEffect(
    () => () => {
      previewBackgroundVar(BG_VARS.opacity, String(persistedRef.current.opacity))
      previewBackgroundVar(BG_VARS.blur, `${persistedRef.current.blurPx}px`)
    },
    []
  )

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

  /**
   * Persist a released slider, then drop the drag override. Clearing only after
   * the store write resolves keeps the value from flashing back to its previous
   * one for a frame between the release and the store update.
   */
  const commitDrag = async (key: "opacity" | "blurPx", value: number) => {
    await setBackground({ [key]: value })
    setDrag(null)
  }

  const applyTuning = useCallback(
    (tuning: WallpaperTuning) => {
      previewBackgroundVar(BG_VARS.opacity, String(tuning.opacity))
      previewBackgroundVar(BG_VARS.blur, `${tuning.blurPx}px`)
      void setBackground({ opacity: tuning.opacity, blurPx: tuning.blurPx })
    },
    [setBackground]
  )

  // Roving focus across the scope radiogroup: a `role="radio"` set is expected
  // to be one tab stop that arrow keys move within, not five separate ones.
  const scopeRefs = useRef<Partial<Record<BackgroundScope, HTMLButtonElement | null>>>({})
  const handleScopeKeyDown = (event: React.KeyboardEvent, index: number) => {
    const delta = ROVING_KEYS[event.key]
    if (!delta) return
    event.preventDefault()
    const next = SCOPE_CARDS[(index + delta + SCOPE_CARDS.length) % SCOPE_CARDS.length]
    void setBackground({ scope: next.scope })
    scopeRefs.current[next.scope]?.focus()
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
            const isActive = background.activeId === wp.id
            const card = (
              <WallpaperCard
                wallpaper={wp}
                active={isActive}
                onActivate={() => void setActiveWallpaper(wp.id)}
                onDelete={!wp.builtin ? () => void handleDelete(wp) : undefined}
                previewFit={
                  isActive ? { position: background.position, focalX, focalY } : undefined
                }
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

      {/* 2b. Rotation. Sits between "which wallpaper" and "how does it sit",
             because it is the question that turns the single choice above into
             a set. Inert without an active wallpaper, same as the tuning below. */}
      <fieldset
        disabled={!hasActive}
        className={cn(!hasActive && "pointer-events-none opacity-50")}
      >
        <WallpaperRotationCard
          rotation={rotation}
          gallery={gallery}
          scrimActive={scrimActive}
          onChange={handleRotationChange}
        />
      </fieldset>

      {/* 3. Adjustments — inert until there's something to adjust. `fieldset`
             only disables form controls, so the Radix sliders below take an
             explicit `disabled` too. */}
      <fieldset
        disabled={!hasActive}
        data-testid="wallpaper-adjustments"
        className={cn("space-y-4", !hasActive && "pointer-events-none opacity-50")}
      >
        {!hasActive && <p className="text-xs text-muted-foreground">{t("noActive")}</p>}

        {/* 3a. Placement — the three "where" controls, which used to be spread
                across a chip row and an unrelated 3-up grid. */}
        <section className="space-y-3 rounded-lg border p-3" data-testid="wallpaper-placement">
          <div className="space-y-0.5">
            <Label className="text-xs">{t("placementTitle")}</Label>
            <p className="text-[11px] text-muted-foreground">{t("placementHint")}</p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-[11px] text-muted-foreground">{t("scopeLabel")}</Label>
            <div
              className="flex flex-wrap gap-1.5"
              role="radiogroup"
              aria-label={t("scope.legend")}
              data-testid="wallpaper-scope-group"
            >
              {SCOPE_CARDS.map((card, index) => {
                const active = background.scope === card.scope
                return (
                  <Button
                    key={card.scope}
                    ref={(node) => {
                      scopeRefs.current[card.scope] = node
                    }}
                    type="button"
                    variant="outline"
                    size="sm"
                    role="radio"
                    aria-checked={active}
                    aria-label={t(card.labelKey)}
                    title={t(card.descriptionKey)}
                    tabIndex={active ? 0 : -1}
                    data-active={active}
                    data-testid={`wallpaper-scope-${card.scope}`}
                    className={cn(
                      "flex items-center gap-1.5 rounded-pill border px-2 py-1 text-xs transition",
                      "data-[active=true]:border-primary data-[active=true]:bg-primary/5",
                      "hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    )}
                    onClick={() => void setBackground({ scope: card.scope })}
                    onKeyDown={(e) => handleScopeKeyDown(e, index)}
                    onMouseEnter={() => setBgPreview(card.scope)}
                    onMouseLeave={clearBgPreview}
                    onFocus={() => setBgPreview(card.scope)}
                    onBlur={clearBgPreview}
                  >
                    <ScopeMockup highlight={card.highlight} className="h-4 w-7 shrink-0" />
                    {t(card.labelKey)}
                  </Button>
                )
              })}
            </div>
          </div>

          {/* Fit and focal point are one decision in two halves: the fit says
              how much of the image survives, the focal point says which part. */}
          <div className="grid gap-3 @md/appearance-pane:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">{t("positionLabel")}</Label>
              <Select
                value={background.position}
                disabled={!hasActive}
                onValueChange={(v) => void setBackground({ position: v as WallpaperPosition })}
              >
                <SelectTrigger className={responsiveSelectClass}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WALLPAPER_POSITIONS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {t(POSITION_LABEL_KEY[p])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                {t(`positionHint.${background.position}`)}
              </p>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <Label className="text-[11px] text-muted-foreground">{t("focalLabel")}</Label>
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {focalX}% · {focalY}%
                </span>
              </div>
              <div
                role="radiogroup"
                aria-label={t("focalLabel")}
                aria-disabled={!focalEnabled}
                data-testid="wallpaper-focal-group"
                className={cn(
                  "grid w-fit grid-cols-3 gap-1 rounded-md border p-1",
                  !focalEnabled && "pointer-events-none opacity-50"
                )}
              >
                {FOCAL_PRESETS.map((preset) => {
                  const selected = activeFocalPreset === preset.id
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      aria-label={t(`focal.${preset.id}`)}
                      title={t(`focal.${preset.id}`)}
                      disabled={!hasActive || !focalEnabled}
                      data-testid={`wallpaper-focal-${preset.id}`}
                      className={cn(
                        "size-5 rounded-sm border transition",
                        "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        selected ? "border-primary bg-primary/20" : "border-transparent bg-muted"
                      )}
                      onClick={() => void setBackground({ focalX: preset.x, focalY: preset.y })}
                    />
                  )
                })}
              </div>
              <p className="text-[11px] text-muted-foreground">
                {focalEnabled ? t("focalHint") : t("focalUnavailable")}
              </p>
            </div>
          </div>
        </section>

        {/* 3b. Readability — the two sliders and the verdict they produce,
                together, because neither number means anything alone. */}
        <section className="space-y-3 rounded-lg border p-3" data-testid="wallpaper-readability">
          <div className="space-y-0.5">
            <Label className="text-xs">{t("readabilityTitle")}</Label>
            <p className="text-[11px] text-muted-foreground">{t("readabilityHint")}</p>
          </div>

          <div className="grid gap-3 @md/appearance-pane:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">
                {t("blurLabel")} · {blurPx}px
              </Label>
              <Slider
                value={[blurPx]}
                min={0}
                max={32}
                step={1}
                disabled={!hasActive}
                onValueChange={(v) => {
                  const next = sliderValue(v)
                  setDrag({ key: "blurPx", value: next })
                  previewBackgroundVar(BG_VARS.blur, `${next}px`)
                }}
                onValueCommit={(v) => void commitDrag("blurPx", sliderValue(v))}
                aria-label={t("blurLabel")}
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">
                {t("opacityLabel")} · {Math.round(opacity * 100)}%
              </Label>
              <Slider
                value={[Math.round(opacity * 100)]}
                min={0}
                max={100}
                step={1}
                disabled={!hasActive}
                onValueChange={(v) => {
                  const next = sliderValue(v) / 100
                  setDrag({ key: "opacity", value: next })
                  previewBackgroundVar(BG_VARS.opacity, String(next))
                }}
                onValueCommit={(v) => void commitDrag("opacity", sliderValue(v) / 100)}
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
                data-measured={verdict.measured}
              >
                {verdict.level.toUpperCase()} {verdict.ratio.toFixed(1)}:1
              </Badge>
              <span className="text-[11px] text-muted-foreground">
                {verdict.measured ? t("opacity.measured") : t("opacity.estimated")}
              </span>
              {verdict.level !== "ok" && (
                <span className="text-xs text-muted-foreground">
                  {verdict.level === "warn" ? t("opacity.warn") : t("opacity.fail")}
                </span>
              )}
              {/* Solve for the highest opacity that still clears AA rather than
                  dropping to a hardcoded 0.4 — on a flat wallpaper that used to
                  throw away most of the image for no readability gain. */}
              {suggestedOpacity !== null && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    previewBackgroundVar(BG_VARS.opacity, String(suggestedOpacity))
                    void setBackground({ opacity: suggestedOpacity })
                  }}
                >
                  {t("opacity.autoFix")}
                </Button>
              )}
            </div>
          )}
        </section>

        <WallpaperThemeGenerator
          key={activeWallpaper?.id}
          wallpaper={activeWallpaper}
          onAnalyzed={(value) => {
            if (activeWallpaper) setAnalysis({ id: activeWallpaper.id, value })
          }}
          onApplyTuning={applyTuning}
        />
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
        <Button
          type="button"
          variant="ghost"
          aria-label={ariaLabel}
          data-testid={testId}
          className={cn(
            "h-auto aspect-video flex-col items-center justify-center gap-1 whitespace-normal rounded-lg border-2 border-dashed",
            "text-muted-foreground transition hover:border-primary hover:text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          )}
        >
          {icon}
          <span className="text-[11px]">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80">{children}</PopoverContent>
    </Popover>
  )
}
