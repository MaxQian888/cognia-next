"use client"

// One tile in the wallpaper gallery. Renders a preview swatch (the
// background CSS itself), the wallpaper's name, and an optional delete
// button (suppressed for built-ins). Clicking the body of the tile
// activates the wallpaper.

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { CheckIcon, Trash2Icon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { resolveSourceToCss, disposeUrl } from "@/lib/appearance/wallpaper-storage"
import type { Wallpaper } from "@/types/appearance"

export interface WallpaperCardProps {
  wallpaper: Wallpaper
  active: boolean
  onActivate: () => void
  onDelete?: () => void
  /** Optional aria label override (i18n hook). */
  ariaLabel?: string
}

export function WallpaperCard({
  wallpaper,
  active,
  onActivate,
  onDelete,
  ariaLabel,
}: WallpaperCardProps) {
  const tAria = useTranslations("settings.appearance.wallpaper.aria")
  const [css, setCss] = useState<string | null>(null)
  const [error, setError] = useState(false)

  // Resolve the source once on mount and whenever the underlying
  // wallpaper changes. We dispose any blob URL on unmount so the gallery
  // doesn't leak handles. Note we only call setError on failure — there's
  // no "reset to false" because successful resolution already triggers a
  // re-render that hides the sentinel.
  useEffect(() => {
    let cancelled = false
    let resolved: string | null = null
    resolveSourceToCss(wallpaper.source)
      .then((next) => {
        if (cancelled) return
        resolved = next
        setCss(next)
        setError(false)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
      if (resolved) disposeUrl(resolved)
    }
  }, [wallpaper.source])

  const isImage = wallpaper.source.kind === "image"
  const showDelete = !wallpaper.builtin && onDelete

  return (
    <div className="group relative">
      <Button
        type="button"
        variant="ghost"
        onClick={onActivate}
        aria-label={ariaLabel ?? wallpaper.name}
        aria-pressed={active}
        className={cn(
          "relative h-auto aspect-video w-full overflow-hidden rounded-lg border-2 p-0 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          active ? "border-primary" : "border-transparent hover:border-border"
        )}
      >
        <div
          className="absolute inset-0"
          style={{
            backgroundColor: wallpaper.source.kind === "color" ? wallpaper.source.value : undefined,
            backgroundImage:
              css && wallpaper.source.kind !== "color" ? (isImage ? css : css) : undefined,
            backgroundSize: isImage ? "cover" : undefined,
            backgroundPosition: "center",
          }}
        />
        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-destructive/20 text-[10px] text-destructive">
            !
          </div>
        )}
        {active && (
          <span className="absolute right-1.5 top-1.5 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <CheckIcon className="size-3" />
          </span>
        )}
      </Button>
      <div className="mt-1 flex items-center justify-between gap-1 text-[11px]">
        <span className="truncate text-muted-foreground" title={wallpaper.name}>
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
