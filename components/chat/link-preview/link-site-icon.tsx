"use client"

/**
 * The leading site mark on an external link (ADR-0218).
 *
 * In order: a local brand icon when the host is one the icon set knows (no
 * request, works offline and under the desktop CSP), the site's favicon when
 * fetching is allowed, and a globe otherwise. The favicon is the one the page
 * declared if its preview is already cached, else `/favicon.ico`; either way it
 * is one request per host, shared by every link to that host.
 */

import { GlobeIcon } from "lucide-react"
import { brandIconAsset } from "@/components/icons/brand-icon"
import { usePreviewImage } from "@/hooks/chat/use-link-preview"
import { brandIdForHost } from "@/lib/chat/link-display"
import { peekLinkPreview } from "@/lib/web/link-preview/preview-store"
import { cn } from "@/lib/utils"

export interface LinkSiteIconProps {
  url: string
  /** Whether the favicon may be requested. Off ⇒ brand icon or globe only. */
  allowFetch: boolean
  className?: string
}

function parseHost(url: string): { host: string; origin: string } | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null
    return { host: parsed.hostname.replace(/^www\./i, ""), origin: parsed.origin }
  } catch {
    return null
  }
}

/** The favicon URL to try for `url`: the declared one if known, else `/favicon.ico`. */
export function faviconCandidate(url: string): string | null {
  const parsed = parseHost(url)
  if (!parsed) return null
  const entry = peekLinkPreview(url)
  if (entry?.status === "ready" && entry.preview.faviconUrl) return entry.preview.faviconUrl
  return `${parsed.origin}/favicon.ico`
}

export function LinkSiteIcon({ url, allowFetch, className }: LinkSiteIconProps) {
  const parsed = parseHost(url)
  const brand = parsed ? brandIconAsset(brandIdForHost(parsed.host)) : null
  const favicon = usePreviewImage(
    !brand && allowFetch ? faviconCandidate(url) : null,
    !brand && allowFetch
  )

  if (brand) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- a 1em inline glyph from the local brand set; next/image needs fixed pixel dimensions
      <img
        src={brand.src}
        alt=""
        aria-hidden
        data-link-site-icon="brand"
        className={cn("chat-link-icon", brand.mono && "dark:invert", className)}
      />
    )
  }
  if (favicon.src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- remote or data: favicon of unknown size
      <img
        src={favicon.src}
        alt=""
        aria-hidden
        data-link-site-icon="favicon"
        className={cn("chat-link-icon", className)}
        onError={favicon.onError}
        referrerPolicy="no-referrer"
      />
    )
  }
  return (
    <GlobeIcon
      aria-hidden
      data-link-site-icon="globe"
      className={cn("chat-link-icon opacity-70", className)}
    />
  )
}
