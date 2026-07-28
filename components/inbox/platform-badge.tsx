"use client"

/**
 * Platform badge — small icon + colour coding per platform kind.
 * Wraps the shadcn `Badge` primitive (ghost variant) so it inherits the same
 * inline-flex / gap / focus-ring contract as every other badge in the app.
 * Per-platform colour comes from `config.colorClass`, applied via className.
 */

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import {
  isPlatformKind,
  type BuiltInPlatformKind,
  type PlatformKind,
} from "@/types/connectors/platform-kind"
import { PlatformIcon } from "@/components/connectors/platform-icons"

interface PlatformConfig {
  label: string
  colorClass: string
}

const PLATFORM_CONFIG: Record<BuiltInPlatformKind, PlatformConfig> = {
  telegram: { label: "TG", colorClass: "text-sky-500" },
  discord: { label: "DC", colorClass: "text-indigo-500" },
  slack: { label: "SL", colorClass: "text-purple-500" },
  lark: { label: "LK", colorClass: "text-teal-500" },
  onebot: { label: "OB", colorClass: "text-orange-500" },
  dingtalk: { label: "DT", colorClass: "text-blue-600" },
  wecom: { label: "WC", colorClass: "text-green-600" },
  "wechat-oa": { label: "WO", colorClass: "text-green-500" },
  "wechat-personal": { label: "WX", colorClass: "text-green-500" },
  "qq-official": { label: "QQ", colorClass: "text-blue-500" },
  email: { label: "EM", colorClass: "text-amber-600" },
  matrix: { label: "MX", colorClass: "text-neutral-500" },
  kook: { label: "KK", colorClass: "text-violet-500" },
  line: { label: "LN", colorClass: "text-green-400" },
  mattermost: { label: "MM", colorClass: "text-blue-700" },
  github: { label: "GH", colorClass: "text-slate-700" },
}

interface PlatformBadgeProps {
  platform: PlatformKind
  className?: string
  /** When true, render only the icon without the label abbreviation. */
  iconOnly?: boolean
}

export function PlatformBadge({ platform, className, iconOnly = false }: PlatformBadgeProps) {
  const config = isPlatformKind(platform)
    ? PLATFORM_CONFIG[platform]
    : {
        label: platform.slice(0, 2).toUpperCase(),
        colorClass: "text-muted-foreground",
      }

  return (
    <Badge
      variant="ghost"
      className={cn(
        // Restore the visible icon size from the original implementation — the
        // Badge default (`[&>svg]:size-3` = 12 px) is too small for a platform
        // glyph in a list row.
        "px-0 py-0 font-medium [&>svg]:size-3.5",
        config.colorClass,
        className
      )}
      title={platform}
      data-testid={`platform-badge-${platform}`}
    >
      <PlatformIcon kind={platform} />
      {!iconOnly && <span className="text-xs leading-none">{config.label}</span>}
    </Badge>
  )
}
