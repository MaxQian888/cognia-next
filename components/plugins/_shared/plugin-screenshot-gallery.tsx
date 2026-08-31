"use client"

// `manifest.screenshots` has existed in the manifest type since the beginning
// and no component ever rendered it. A plugin could ship preview images and
// there was nowhere in the product they appeared, which is part of why the
// installed library looked nothing like a marketplace.
//
// Every screenshot goes through the same `resolvePluginIcon` classification
// the icon uses, so a plugin-relative path (`screenshots/1.png`) resolves
// against the install root under the same path-traversal guard, and an entry
// this host cannot load is dropped rather than rendered broken.

import { useMemo } from "react"
import { useTranslations } from "next-intl"

import { ScrollShadowRow } from "@/components/plugins/scroll-shadow-row"
import { usePluginFileSrcConverter } from "@/hooks/plugins/use-plugin-icon-src"
import { resolvePluginIcon } from "@/lib/plugin/utils/icon"
import { pluginIconRender, type FileSrcConverter } from "@/lib/plugin/utils/icon-src"
import { cn } from "@/lib/utils"

export interface PluginScreenshotGalleryProps {
  screenshots: readonly string[] | undefined
  /** Install root, so plugin-relative paths resolve. */
  pluginRoot?: string
  /** Test seam. Production resolves Tauri's asset protocol on its own. */
  convertFileSrc?: FileSrcConverter
  className?: string
}

export function PluginScreenshotGallery({
  screenshots,
  pluginRoot,
  convertFileSrc,
  className,
}: PluginScreenshotGalleryProps) {
  const t = useTranslations("plugins.detail")
  const resolved = useMemo(
    () =>
      (Array.isArray(screenshots) ? screenshots : [])
        .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
        .map((entry) => resolvePluginIcon({ icon: entry, pluginRoot })),
    [screenshots, pluginRoot]
  )
  const needsConverter = resolved.some(
    (entry) => entry?.kind === "image" && entry.transport === "file"
  )
  const hostConverter = usePluginFileSrcConverter(needsConverter && !convertFileSrc)
  const converter = convertFileSrc ?? hostConverter

  const sources = useMemo(
    () =>
      resolved
        .map((entry) => pluginIconRender(entry, converter))
        .filter((render): render is { kind: "image"; src: string } => render?.kind === "image")
        .map((render) => render.src),
    [resolved, converter]
  )

  // No images this host can load means no block at all. An empty frame with a
  // heading would claim the plugin ships previews when it does not.
  if (sources.length === 0) return null

  return (
    <section className={cn("space-y-2", className)} data-testid="plugin-screenshot-gallery">
      <h3 className="text-xs font-semibold">{t("screenshots")}</h3>
      <ScrollShadowRow scrollerClassName="pb-1" testId="plugin-screenshots">
        <div className="flex w-max gap-2">
          {sources.map((src, index) => (
            /* eslint-disable-next-line @next/next/no-img-element -- plugin-supplied preview, and arbitrary plugin URLs cannot go through next/image in a static export */
            <img
              key={src}
              src={src}
              alt={t("screenshotAlt", { index: index + 1 })}
              loading="lazy"
              className="h-40 w-auto shrink-0 rounded-md border object-cover"
              data-testid="plugin-screenshot"
            />
          ))}
        </div>
      </ScrollShadowRow>
    </section>
  )
}
