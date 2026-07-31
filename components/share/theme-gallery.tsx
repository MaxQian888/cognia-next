"use client"

// Visual theme picker for the share/export dialogs. Replaces a plain <Select>
// with a scrollable grid of cheap CSS mini-swatches (no per-theme iframe): each
// swatch paints the theme's own tokens (bg, accent banner, message pills) and
// flags themes that ship a real wallpaper. Keyboard-navigable radiogroup.

import { useRef } from "react"
import { useTranslations } from "next-intl"
import { ImageIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { THEMES, THEME_LIST, type ThemeId } from "@/lib/export/html/syntax-themes"
import { themeHasWallpaper } from "@/lib/export/html/theme-wallpaper"

export interface ThemeGalleryProps {
  value: ThemeId
  onChange: (id: ThemeId) => void
  /** Themes to show; defaults to the full THEME_LIST. */
  themes?: readonly { id: ThemeId; label: string }[]
  className?: string
}

export function ThemeGallery({
  value,
  onChange,
  themes = THEME_LIST,
  className,
}: ThemeGalleryProps) {
  const t = useTranslations("share.themeGallery")
  const refs = useRef<(HTMLButtonElement | null)[]>([])

  const move = (from: number, delta: number) => {
    const next = (from + delta + themes.length) % themes.length
    onChange(themes[next].id)
    refs.current[next]?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        e.preventDefault()
        move(index, 1)
        break
      case "ArrowLeft":
      case "ArrowUp":
        e.preventDefault()
        move(index, -1)
        break
      case "Home":
        e.preventDefault()
        onChange(themes[0].id)
        refs.current[0]?.focus()
        break
      case "End":
        e.preventDefault()
        onChange(themes[themes.length - 1].id)
        refs.current[themes.length - 1]?.focus()
        break
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label={t("label")}
      data-testid="theme-gallery"
      className={cn(
        "grid max-h-64 grid-cols-2 gap-2 overflow-y-auto rounded-md border border-border p-2 sm:grid-cols-3",
        className
      )}
    >
      {themes.map((th, i) => {
        const tokens = THEMES[th.id]
        const selected = th.id === value
        const hasWallpaper = themeHasWallpaper(th.id)
        return (
          <button
            key={th.id}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={th.label}
            tabIndex={selected ? 0 : -1}
            data-testid={`theme-swatch-${th.id}`}
            onClick={() => onChange(th.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              "group flex flex-col gap-1 rounded-md border p-1.5 text-left transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected
                ? "border-primary ring-2 ring-primary"
                : "border-border hover:border-primary/50"
            )}
          >
            <span
              aria-hidden
              className="relative flex h-12 flex-col justify-between overflow-hidden rounded"
              style={{ backgroundColor: tokens.bg }}
            >
              <span className="h-2 w-full" style={{ backgroundColor: tokens.accent }} />
              <span className="flex flex-col gap-0.5 px-1 pb-1">
                <span
                  className="h-1.5 w-3/4 self-end rounded-sm"
                  style={{ backgroundColor: tokens.userBg }}
                />
                <span
                  className="h-1.5 w-2/3 rounded-sm"
                  style={{ backgroundColor: tokens.assistantBg }}
                />
              </span>
              {hasWallpaper && (
                <ImageIcon
                  className="absolute right-1 top-1 size-3"
                  style={{ color: tokens.accent }}
                  aria-label={t("wallpaperBadge")}
                />
              )}
            </span>
            <span className="truncate text-[11px] font-medium text-foreground">{th.label}</span>
          </button>
        )
      })}
    </div>
  )
}
