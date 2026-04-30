"use client"

// Visual storage breakdown — a stacked bar with per-category colors plus a
// collapsible detail list with optional clear-button. Adapted from
// D:\Project\Cognia\components\settings\data\storage-breakdown.tsx; the
// CATEGORY_ICONS / CATEGORY_COLORS are pruned to the categories cognia-next
// actually populates.

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import {
  BotIcon,
  CogIcon,
  FileCodeIcon,
  FileTextIcon,
  HistoryIcon,
  KeyRoundIcon,
  Layers3Icon,
  type LucideIcon,
  MessageCircleIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PuzzleIcon,
  SettingsIcon,
  ShieldIcon,
  Trash2Icon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ChevronDownIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { StorageCategory, StorageCategoryInfo } from "@/lib/storage"

const CATEGORY_ICONS: Record<StorageCategory, LucideIcon> = {
  settings: SettingsIcon,
  session: MessageSquareIcon,
  chat: MessageCircleIcon,
  character: BotIcon,
  skill: PuzzleIcon,
  team: Layers3Icon,
  mcp: PuzzleIcon,
  preset: FileTextIcon,
  canvas: FileCodeIcon,
  trustedWorkspace: ShieldIcon,
  ttsKey: KeyRoundIcon,
  backupHistory: HistoryIcon,
  system: CogIcon,
  other: MoreHorizontalIcon,
}

const CATEGORY_COLORS: Record<StorageCategory, string> = {
  settings: "bg-blue-500",
  session: "bg-green-500",
  chat: "bg-emerald-500",
  character: "bg-orange-500",
  skill: "bg-yellow-500",
  team: "bg-cyan-500",
  mcp: "bg-purple-500",
  preset: "bg-indigo-500",
  canvas: "bg-amber-500",
  trustedWorkspace: "bg-rose-500",
  ttsKey: "bg-pink-500",
  backupHistory: "bg-teal-500",
  system: "bg-slate-500",
  other: "bg-zinc-500",
}

interface StorageBreakdownProps {
  categories: StorageCategoryInfo[]
  totalSize: number
  formatBytes: (bytes: number) => string
  onClearCategory?: (category: StorageCategory) => void
  isClearing?: boolean
  className?: string
}

export function StorageBreakdown({
  categories,
  totalSize,
  formatBytes,
  onClearCategory,
  isClearing = false,
  className,
}: StorageBreakdownProps) {
  const t = useTranslations("settings.data.breakdown")

  const sortedCategories = useMemo(() => {
    return [...categories].filter((c) => c.totalSize > 0).sort((a, b) => b.totalSize - a.totalSize)
  }, [categories])

  const topCategories = sortedCategories.slice(0, 5)
  const otherCategories = sortedCategories.slice(5)
  const otherTotal = otherCategories.reduce<number>((sum, c) => sum + c.totalSize, 0)
  const denominator =
    totalSize > 0 ? totalSize : sortedCategories.reduce((s, c) => s + c.totalSize, 0)

  if (sortedCategories.length === 0) {
    return (
      <div className={cn("py-4 text-center text-sm text-muted-foreground", className)}>
        {t("noData")}
      </div>
    )
  }

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
        {topCategories.map((cat) => {
          const percentage = denominator > 0 ? (cat.totalSize / denominator) * 100 : 0
          return (
            <Tooltip key={cat.category}>
              <TooltipTrigger asChild>
                <div
                  className={cn(CATEGORY_COLORS[cat.category], "h-full transition-all")}
                  style={{ width: `${percentage}%` }}
                  data-testid={`breakdown-bar-${cat.category}`}
                />
              </TooltipTrigger>
              <TooltipContent>
                <p className="font-medium">{cat.displayName}</p>
                <p className="text-xs text-muted-foreground">
                  {formatBytes(cat.totalSize)} ({percentage.toFixed(1)}%)
                </p>
              </TooltipContent>
            </Tooltip>
          )
        })}
        {otherTotal > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className="h-full bg-zinc-400 transition-all"
                style={{ width: `${(otherTotal / denominator) * 100}%` }}
              />
            </TooltipTrigger>
            <TooltipContent>
              <p className="font-medium">{t("other")}</p>
              <p className="text-xs text-muted-foreground">
                {formatBytes(otherTotal)} ({((otherTotal / denominator) * 100).toFixed(1)}%)
              </p>
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      <div className="flex flex-wrap gap-2 text-[10px]">
        {topCategories.map((cat) => {
          const Icon = CATEGORY_ICONS[cat.category]
          return (
            <div key={cat.category} className="flex items-center gap-1">
              <div className={cn("size-2 rounded-full", CATEGORY_COLORS[cat.category])} />
              <Icon className="size-3 text-muted-foreground" />
              <span>{cat.displayName}</span>
            </div>
          )
        })}
        {otherTotal > 0 && (
          <div className="flex items-center gap-1">
            <div className="size-2 rounded-full bg-zinc-400" />
            <span>{t("other")}</span>
          </div>
        )}
      </div>

      <Collapsible>
        <CollapsibleTrigger className="flex w-full items-center justify-between py-1 text-xs text-muted-foreground hover:text-foreground">
          <span>{t("viewDetails")}</span>
          <ChevronDownIcon className="size-3" />
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-1.5 pt-2">
          {sortedCategories.map((cat) => {
            const Icon = CATEGORY_ICONS[cat.category]
            const percentage = denominator > 0 ? (cat.totalSize / denominator) * 100 : 0
            return (
              <div
                key={cat.category}
                className="flex items-center gap-2 rounded-md border p-1.5 text-xs"
              >
                <div
                  className={cn(
                    "flex size-6 items-center justify-center rounded",
                    CATEGORY_COLORS[cat.category]
                  )}
                >
                  <Icon className="size-3.5 text-white" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between">
                    <span className="truncate font-medium">{cat.displayName}</span>
                    <span className="ml-2 text-muted-foreground">
                      {formatBytes(cat.totalSize)} · {cat.itemCount}
                    </span>
                  </div>
                  <Progress value={percentage} className="mt-0.5 h-1" />
                </div>
                {onClearCategory && cat.totalSize > 0 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6"
                        onClick={() => onClearCategory(cat.category)}
                        disabled={isClearing}
                        aria-label={t("clearCategory")}
                      >
                        <Trash2Icon className="size-3 text-muted-foreground hover:text-destructive" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("clearCategory")}</TooltipContent>
                  </Tooltip>
                )}
              </div>
            )
          })}
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
