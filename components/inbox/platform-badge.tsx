"use client"

/**
 * Platform badge — small icon + colour coding per platform kind.
 * Uses Lucide icons where a reasonable analogue exists; falls back to
 * a simple text abbreviation for less-common platforms.
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
    <span
      className={cn("inline-flex items-center gap-1", config.colorClass, className)}
      title={platform}
      data-testid={`platform-badge-${platform}`}
    >
      <Icon className="h-3.5 w-3.5" />
      {!iconOnly && <span className="text-xs font-medium leading-none">{config.label}</span>}
    </span>
  )
}
