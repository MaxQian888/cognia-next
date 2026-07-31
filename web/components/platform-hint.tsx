"use client"

import { Icon, type IconName } from "@web/components/icon"
import type { CommonCopy, DownloadPageCopy } from "@web/content/types"
import { useHasMounted } from "@web/hooks/use-has-mounted"
import { detectPlatform, type Platform } from "@web/lib/platform"

interface PlatformHintProps {
  common: CommonCopy
  copy: DownloadPageCopy["platformHint"]
}

/** One glyph per platform — a shared icon would carry no information. */
const PLATFORM_ICON: Record<Platform, IconName> = {
  macos: "laptop",
  windows: "appWindow",
  linux: "terminal",
}

/**
 * "Detected: macOS", beside the download page's call to action.
 *
 * This finally renders `CommonCopy.download.detecting`, a key the content
 * schema has declared since the site was built and which nothing has ever
 * shown — the schema anticipated a platform detector that was never written.
 *
 * Client-only by necessity: a static export has no request, so there is no user
 * agent at build time. Before mount it renders the "detecting" string rather
 * than an empty box, so the line does not appear from nowhere on hydration.
 */
export function PlatformHint({ common, copy }: PlatformHintProps) {
  const mounted = useHasMounted()

  if (!mounted) {
    return <p className="font-mono text-xs text-muted">{common.download.detecting}</p>
  }

  // `maxTouchPoints` is what separates an iPad from a Mac — iPadOS ships a
  // desktop Safari UA, so without it the hint tells a tablet it runs macOS.
  const platform = detectPlatform(navigator.userAgent, {
    maxTouchPoints: navigator.maxTouchPoints,
  })

  if (!platform) {
    return <p className="font-mono text-xs text-muted">{copy.unknown}</p>
  }

  const name = {
    macos: common.download.platformMacos,
    windows: common.download.platformWindows,
    linux: common.download.platformLinux,
  }[platform]

  return (
    <p className="flex items-center gap-2 font-mono text-xs text-muted">
      <Icon name={PLATFORM_ICON[platform]} size={14} />
      <span>
        {copy.label} <span className="text-ink">{name}</span>
      </span>
    </p>
  )
}
