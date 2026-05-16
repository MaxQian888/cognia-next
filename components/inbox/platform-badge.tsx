"use client"

/**
 * Platform badge — small icon + colour coding per platform kind.
 * Wraps the shadcn `Badge` primitive (ghost variant) so it inherits the same
 * inline-flex / gap / focus-ring contract as every other badge in the app.
 * Per-platform colour comes from `config.colorClass`, applied via className.
 */

import {
  SendIcon,
  MessageCircleIcon,
  HashIcon,
  BirdIcon,
  BotIcon,
  MailIcon,
  GridIcon,
  GitBranchIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { PlatformKind } from "@/types/connectors/platform-kind"

interface PlatformConfig {
  label: string
  icon: React.ComponentType<{ className?: string }>
  colorClass: string
}

const PLATFORM_CONFIG: Record<PlatformKind, PlatformConfig> = {
  telegram: { label: "TG", icon: SendIcon, colorClass: "text-sky-500" },
  discord: { label: "DC", icon: HashIcon, colorClass: "text-indigo-500" },
  slack: { label: "SL", icon: HashIcon, colorClass: "text-purple-500" },
  lark: { label: "LK", icon: BirdIcon, colorClass: "text-teal-500" },
  onebot: { label: "OB", icon: BotIcon, colorClass: "text-orange-500" },
  dingtalk: { label: "DT", icon: MessageCircleIcon, colorClass: "text-blue-600" },
  wecom: { label: "WC", icon: MessageCircleIcon, colorClass: "text-green-600" },
  "wechat-oa": { label: "WO", icon: MessageCircleIcon, colorClass: "text-green-500" },
  "qq-official": { label: "QQ", icon: MessageCircleIcon, colorClass: "text-blue-500" },
  email: { label: "EM", icon: MailIcon, colorClass: "text-amber-600" },
  matrix: { label: "MX", icon: GridIcon, colorClass: "text-neutral-500" },
  kook: { label: "KK", icon: GitBranchIcon, colorClass: "text-violet-500" },
  line: { label: "LN", icon: MessageCircleIcon, colorClass: "text-green-400" },
  mattermost: { label: "MM", icon: HashIcon, colorClass: "text-blue-700" },
  github: { label: "GH", icon: GitBranchIcon, colorClass: "text-slate-700" },
}

interface PlatformBadgeProps {
  platform: PlatformKind
  className?: string
  /** When true, render only the icon without the label abbreviation. */
  iconOnly?: boolean
}

export function PlatformBadge({ platform, className, iconOnly = false }: PlatformBadgeProps) {
  const config = PLATFORM_CONFIG[platform] ?? {
    label: platform.slice(0, 2).toUpperCase(),
    icon: MessageCircleIcon,
    colorClass: "text-muted-foreground",
  }

  const Icon = config.icon

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
      <Icon />
      {!iconOnly && <span className="text-xs leading-none">{config.label}</span>}
    </Badge>
  )
}
