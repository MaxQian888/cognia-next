"use client"

/**
 * Platform badge — small icon + colour coding per platform kind.
 * Wraps the shadcn `Badge` primitive (ghost variant) so it inherits the same
 * inline-flex / gap / focus-ring contract as every other badge in the app.
 * Per-platform colour comes from `PLATFORM_COLOR`, applied via className; the
 * two-letter abbreviation comes from i18n (`inbox.platformBadge.abbr.<kind>`).
 *
 * Dormancy label (three axes — see CLAUDE.md working rule 7): platforms whose
 * `ConnectorMeta.status` is `"planned"` in `lib/connectors/adapter-metadata.ts`
 * (email / kook / line / mattermost) have no adapter factory, no config form,
 * and no i18n abbreviation. They render through the same generic fallback a
 * plugin-owned platform id gets — `kind.slice(0, 2).toUpperCase()`, muted
 * colour — with `title` set to the "Planned platform" label so the state is
 * visible in the UI, and `platform-badge.test.tsx` pins that fallback.
 */

import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { getConnectorMeta } from "@/lib/connectors/adapter-metadata"
import type { BuiltInPlatformKind, PlatformKind } from "@/types/connectors/platform-kind"
import { PlatformIcon } from "@/components/connectors/platform-icons"

/**
 * Colour per *buildable* platform (has an adapter-registry factory + i18n
 * abbreviation). Planned kinds are deliberately absent so they fall through
 * to the generic fallback below.
 */
const PLATFORM_COLOR: Partial<Record<BuiltInPlatformKind, string>> = {
  telegram: "text-sky-500",
  discord: "text-indigo-500",
  slack: "text-purple-500",
  lark: "text-teal-500",
  onebot: "text-orange-500",
  dingtalk: "text-blue-600",
  wecom: "text-green-600",
  "wechat-oa": "text-green-500",
  "wechat-personal": "text-green-500",
  "qq-official": "text-blue-500",
  matrix: "text-neutral-500",
}

/** Kinds that have an i18n abbreviation under `inbox.platformBadge.abbr.*`. */
export const PLATFORM_BADGE_ABBR_KINDS = Object.keys(PLATFORM_COLOR) as BuiltInPlatformKind[]

/** Generic abbreviation for plugin-owned and planned platform ids. */
export function fallbackPlatformAbbr(platform: string): string {
  return platform.slice(0, 2).toUpperCase()
}

function isAbbrKind(platform: PlatformKind): platform is BuiltInPlatformKind {
  return Object.prototype.hasOwnProperty.call(PLATFORM_COLOR, platform)
}

interface PlatformBadgeProps {
  platform: PlatformKind
  className?: string
  /** When true, render only the icon without the label abbreviation. */
  iconOnly?: boolean
}

export function PlatformBadge({ platform, className, iconOnly = false }: PlatformBadgeProps) {
  const t = useTranslations("inbox.platformBadge")
  const buildable = isAbbrKind(platform)
  const planned = getConnectorMeta(platform)?.status === "planned"

  const label = buildable ? t(`abbr.${platform}`) : fallbackPlatformAbbr(platform)
  const colorClass = buildable ? PLATFORM_COLOR[platform] : "text-muted-foreground"

  return (
    <Badge
      variant="ghost"
      className={cn(
        // Restore the visible icon size from the original implementation — the
        // Badge default (`[&>svg]:size-3` = 12 px) is too small for a platform
        // glyph in a list row.
        "px-0 py-0 font-medium [&>svg]:size-3.5",
        colorClass,
        className
      )}
      title={planned ? t("planned") : platform}
      data-testid={`platform-badge-${platform}`}
      data-planned={planned ? "true" : undefined}
    >
      <PlatformIcon kind={platform} />
      {!iconOnly && <span className="text-xs leading-none">{label}</span>}
    </Badge>
  )
}
