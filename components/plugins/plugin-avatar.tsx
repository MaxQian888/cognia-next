"use client"

// Visual identity for a plugin. Renders, in priority order:
//   1. an image when `icon` is a data:/http(s):/absolute URL,
//   2. a Lucide glyph when `icon` is a Lucide icon name (reuses the shared
//      `resolveIcon` registry), else
//   3. a deterministic initial-avatar (first letter + a colour hashed from a
//      stable seed) so every plugin still has a distinct visual.
//
// `manifest.icon` and `manifest.screenshots` exist in the manifest type but
// were never rendered in the installed library before this. The avatar gives
// the list/grid/detail surfaces a real marketplace look.
//
// Callers should pass `resolvedIcon` whenever they have it. The host already
// classifies every icon into lucide / inline / remote / file / public with a
// path-traversal guard and stores the result on `Plugin.resolvedIcon` and
// `PluginRegistryEntry.resolvedIcon`, and nothing read either field: every
// surface handed over the raw `manifest.icon` string, whose relative form
// (`assets/icon.png`) fails the image test below and silently degraded to a
// letter. `icon` remains supported for callers that only have the raw string.

import { createElement, useMemo } from "react"
import { resolveIcon } from "@/lib/a2ui/resolve-icon"
import { usePluginIconSrc } from "@/hooks/plugins/use-plugin-icon-src"
import { resolvePluginIcon } from "@/lib/plugin/utils/icon"
import { cn } from "@/lib/utils"
import type { PluginResolvedIcon } from "@/types/plugin"

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
  /** Raw manifest icon — Lucide name or data/URL. */
  icon?: string
  /**
   * The host's already-resolved icon. Preferred over `icon`: it is the only
   * form that can render a plugin-relative asset path.
   */
  resolvedIcon?: PluginResolvedIcon
  /**
   * The plugin's install root (`PluginRow.path`). Given this, the avatar
   * resolves `icon` itself through the SAME `resolvePluginIcon` the host uses,
   * so a Dexie row is enough and no caller has to reach into the runtime
   * store for `Plugin.resolvedIcon`.
   */
  pluginRoot?: string
  /** Stable seed for the fallback colour (plugin id preferred). */
  seed?: string
  /** Square px size. */
  size?: number
  className?: string
}

export function PluginAvatar({
  name,
  icon,
  resolvedIcon,
  pluginRoot,
  seed,
  size = 20,
  className,
}: Props) {
  const dimension = { width: size, height: size }
  const effectiveResolved = useMemo(
    () => resolvedIcon ?? resolvePluginIcon({ icon, pluginRoot }),
    [resolvedIcon, icon, pluginRoot]
  )
  const resolved = usePluginIconSrc(effectiveResolved)

  if (resolved?.kind === "image") {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- data/remote/asset-protocol plugin icon, next/image can't optimize arbitrary plugin URLs in static export
      <img
        src={resolved.src}
        alt=""
        aria-hidden
        style={dimension}
        className={cn("shrink-0 rounded-md object-cover", className)}
        data-testid="plugin-avatar-image"
      />
    )
  }

  const resolvedLucide = resolved?.kind === "lucide" ? resolveIcon(resolved.name) : null
  if (resolvedLucide) {
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
        {createElement(resolvedLucide, { className: "size-[62%]" })}
      </span>
    )
  }

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
