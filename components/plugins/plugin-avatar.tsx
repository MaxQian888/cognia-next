"use client"

// Visual identity for a plugin. Renders, in priority order:
//   1. an image when `icon` is a data:/http(s):/absolute URL,
//   2. a Lucide glyph when `icon` is a Lucide icon name (reuses the shared
//      `resolveIcon` registry), else
//   3. a deterministic initial-avatar (first letter + a colour hashed from a
//      stable seed) so every plugin still has a distinct visual.
//
// `manifest.icon` and `manifest.screenshots` exist in the manifest type but
// were never rendered in the installed library before this; the avatar gives
// the list/grid/detail surfaces a real marketplace look.

import { createElement } from "react"
import { resolveIcon } from "@/lib/a2ui/resolve-icon"
import { cn } from "@/lib/utils"

const PALETTE = [
  "bg-rose-500",
  "bg-orange-500",
  "bg-amber-500",
  "bg-lime-500",
  "bg-emerald-500",
  "bg-teal-500",
  "bg-sky-500",
  "bg-indigo-500",
  "bg-violet-500",
  "bg-fuchsia-500",
]

function isImageSrc(icon: string): boolean {
  return (
    icon.startsWith("data:") ||
    icon.startsWith("http://") ||
    icon.startsWith("https://") ||
    icon.startsWith("/")
  )
}

function colorFor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0
  }
  return PALETTE[h % PALETTE.length]
}

interface Props {
  name: string
  /** Manifest icon — Lucide name or data/URL. */
  icon?: string
  /** Stable seed for the fallback colour (plugin id preferred). */
  seed?: string
  /** Square px size. */
  size?: number
  className?: string
}

export function PluginAvatar({ name, icon, seed, size = 20, className }: Props) {
  const dimension = { width: size, height: size }

  if (icon && isImageSrc(icon)) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- data/remote plugin icon, next/image can't optimize arbitrary plugin URLs in static export
      <img
        src={icon}
        alt=""
        aria-hidden
        style={dimension}
        className={cn("shrink-0 rounded-md object-cover", className)}
        data-testid="plugin-avatar-image"
      />
    )
  }

  const Lucide = icon ? resolveIcon(icon) : null
  if (Lucide) {
    return (
      <span
        aria-hidden
        style={dimension}
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-md bg-muted text-foreground",
          className
        )}
        data-testid="plugin-avatar-lucide"
      >
        {createElement(Lucide, { className: "size-[62%]" })}
      </span>
    )
  }

  const initial = (name.trim()[0] ?? "?").toUpperCase()
  return (
    <span
      aria-hidden
      style={{ ...dimension, fontSize: Math.round(size * 0.5) }}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md font-semibold text-white",
        colorFor(seed || name || "?"),
        className
      )}
      data-testid="plugin-avatar-initial"
    >
      {initial}
    </span>
  )
}
