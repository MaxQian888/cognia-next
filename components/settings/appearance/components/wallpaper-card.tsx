"use client"

// One tile in the wallpaper gallery. Renders a preview swatch (the
// background CSS itself), the wallpaper's name, and an optional delete
// button (suppressed for built-ins). Clicking the body of the tile
// activates the wallpaper.
//
// A tile can also be *unopenable on this device*. `wallpapers` used to be
// classified `shared` in the settings-sync table, so a paired phone and desktop
// mirrored their libraries onto each other — and every image wallpaper is a
// reference into the storage of the machine that saved it (`disk` = a path
// under that Tauri host's appData, `indexeddb` = a key in that browser's blob
// store). The classification is fixed, but rows mirrored before that are still
// sitting in the settings row of everyone who was paired.
//
// Those tiles used to render a bare red "!" with no explanation and stay
// clickable — and activating one made `resolveSourceToCss` throw, which
// `BackgroundApplier` handles by switching the whole background off. So the
// user's wallpaper vanished and nothing said why. Now the binding is checked
// up front (no pointless IDB round-trip), the tile says which device holds the
// image, and it cannot be activated. Delete stays available: tidying the
// gallery is the only action that actually helps, and it is the user's call —
// nothing sweeps these rows automatically.

import { useEffect, useState, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, CheckIcon, Trash2Icon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { resolveSourceToCss, disposeUrl } from "@/lib/appearance/wallpaper-storage"
import { wallpaperUnavailableReason } from "@/lib/appearance/wallpaper-availability"
import { backgroundFitStyle } from "@/lib/appearance/background-fit"
import { isTauri } from "@/lib/tauri"
import type { Wallpaper, WallpaperPosition, WallpaperSource } from "@/types/appearance"

// Stable identities for `useSyncExternalStore`. The runtime a webview is
// running in cannot change while the page is alive, so there is nothing to
// subscribe to — the store exists purely to keep the server and client
// snapshots separate through hydration.
const subscribeNever = () => () => {}
const serverIsNotDesktop = () => false

export interface WallpaperCardProps {
  wallpaper: Wallpaper
  active: boolean
  onActivate: () => void
  onDelete?: () => void
  /** Optional aria label override (i18n hook). */
  ariaLabel?: string
  /**
   * Fit to preview inside the tile. Passed for the active wallpaper only, so
   * the gallery answers "what does contain look like?" without the user having
   * to squint at the live app behind the settings sheet. Everything else keeps
   * the neutral `cover` thumbnail.
   */
  previewFit?: { position: WallpaperPosition; focalX?: number; focalY?: number }
}

export function WallpaperCard({
  wallpaper,
  active,
  onActivate,
  onDelete,
  ariaLabel,
  previewFit,
}: WallpaperCardProps) {
  const tAria = useTranslations("settings.appearance.wallpaper.aria")
  const t = useTranslations("settings.appearance.wallpaper.unavailable")
  const [css, setCss] = useState<string | null>(null)
  // The source whose resolve rejected, rather than a boolean: latching a flag
  // would keep the sentinel up for one frame after the user picks a different
  // wallpaper, and comparing identities makes the failure fall away with the
  // source that caused it. `wallpaper.source` is a stable reference off the
  // settings row, which is what the effect already keys on.
  const [failedSource, setFailedSource] = useState<WallpaperSource | null>(null)

  // `isTauri()` reads a `window` marker, so it is false during the static-export
  // prerender and true in the desktop webview — deciding markup from it directly
  // would hydrate into a mismatch. Subscribing with a `false` server snapshot is
  // the sanctioned way to let the client-only answer arrive after hydration.
  const isDesktopHost = useSyncExternalStore(subscribeNever, isTauri, serverIsNotDesktop)

  const foreign = wallpaperUnavailableReason(wallpaper.source, isDesktopHost)
  const error = failedSource === wallpaper.source

  // Resolve the source once on mount and whenever the underlying
  // wallpaper changes. We dispose any blob URL on unmount so the gallery
  // doesn't leak handles.
  useEffect(() => {
    // Nothing to resolve when the bytes are on a machine we are not — the old
    // code let the resolve throw and caught it, which on a phone meant a Tauri
    // `invoke` per foreign tile every time the gallery rendered.
    if (foreign) return
    let cancelled = false
    let resolved: string | null = null
    resolveSourceToCss(wallpaper.source)
      .then((next) => {
        if (cancelled) return
        resolved = next
        setCss(next)
      })
      .catch(() => {
        if (!cancelled) setFailedSource(wallpaper.source)
      })
    return () => {
      cancelled = true
      if (resolved) disposeUrl(resolved)
    }
  }, [wallpaper.source, foreign])

  // A tile is unopenable either because the bytes belong to another device
  // (known up front) or because they went missing from this one (only a failed
  // resolve can tell us). The user sees one state; only the sentence differs.
  const unavailable = foreign !== null || error
  const unavailableText = foreign ? t(foreign) : error ? t("missing") : null

  const isImage = wallpaper.source.kind === "image"
  const showDelete = !wallpaper.builtin && onDelete
  // Only image sources have a fit to preview — a gradient or solid color fills
  // the tile either way, and `tile`/`center` at thumbnail scale would just
  // render a misleading crop of them.
  const fit =
    isImage && previewFit
      ? backgroundFitStyle(previewFit.position, previewFit.focalX, previewFit.focalY)
      : { backgroundSize: isImage ? "cover" : undefined, backgroundPosition: "center" }

  return (
    <div className="group relative">
      <Button
        type="button"
        variant="ghost"
        // Activating an unopenable tile is what used to switch the whole
        // background off, so the affordance is withdrawn rather than left to
        // fail. `title` carries the full sentence the tile is too small to show.
        disabled={unavailable}
        onClick={onActivate}
        aria-label={
          unavailable
            ? t("aria", { name: ariaLabel ?? wallpaper.name })
            : (ariaLabel ?? wallpaper.name)
        }
        title={unavailableText ?? undefined}
        aria-pressed={active}
        className={cn(
          "relative h-auto aspect-video w-full overflow-hidden rounded-lg border-2 p-0 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          active ? "border-primary" : "border-transparent hover:border-border",
          // `disabled` already blocks the click; this keeps the tile legible
          // rather than letting the default 50% opacity grey out the label too.
          unavailable && "disabled:opacity-100"
        )}
      >
        <div
          className="absolute inset-0"
          data-testid="wallpaper-card-preview"
          style={{
            backgroundColor: wallpaper.source.kind === "color" ? wallpaper.source.value : undefined,
            backgroundImage: css && wallpaper.source.kind !== "color" ? css : undefined,
            ...fit,
          }}
        />
        {unavailable && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-background/85 px-2 text-center"
            data-testid="wallpaper-card-unavailable"
          >
            <AlertTriangleIcon className="size-3.5 text-muted-foreground" aria-hidden />
            <span className="text-[10px] leading-tight font-medium text-muted-foreground">
              {t("badge")}
            </span>
          </div>
        )}
        {active && (
          <span className="absolute right-1.5 top-1.5 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <CheckIcon className="size-3" />
          </span>
        )}
      </Button>
      <div className="mt-1 flex items-center justify-between gap-1 text-[11px]">
        <span
          className={cn("truncate text-muted-foreground", unavailable && "line-through")}
          title={wallpaper.name}
        >
          {wallpaper.name}
        </span>
        {showDelete && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-destructive opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100"
            onClick={(e) => {
              e.stopPropagation()
              onDelete?.()
            }}
            aria-label={tAria("delete", { name: wallpaper.name })}
            data-testid="wallpaper-delete-button"
          >
            <Trash2Icon className="size-3" />
          </Button>
        )}
      </div>
    </div>
  )
}
