"use client"

import { memo } from "react"
import { useTranslations } from "next-intl"
import { CheckIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { getCategoryMeta } from "@/lib/skills/categories"
import type { MarketplaceItem } from "@/lib/skills/marketplace-types"

interface Props {
  item: MarketplaceItem
  installed: boolean
  /** Whether this row is shown in the detail pane. */
  active: boolean
  onSelect: (item: MarketplaceItem) => void
}

/**
 * Compact row for the Browse master-detail list (left pane): category icon,
 * name, author, installed check.
 */
export const SkillMarketplaceListItem = memo(function SkillMarketplaceListItem({
  item,
  installed,
  active,
  onSelect,
}: Props) {
  const tMp = useTranslations("skills.marketplace")
  const cat = getCategoryMeta(item.category)
  const Icon = cat.icon

  return (
    <button
      type="button"
      onClick={() => onSelect(item)}
      className={cn(
        "flex w-full min-w-0 items-center gap-2.5 rounded-lg border-l-2 border-l-transparent px-2.5 py-2 text-left transition-colors min-h-11 md:min-h-0",
        active ? "border-l-primary bg-accent font-medium" : "hover:bg-muted/50"
      )}
    >
      <span
        className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-md", cat.color)}
      >
        <Icon className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{item.name}</span>
        <span className="block truncate text-[11px] font-normal text-muted-foreground">
          {item.author ? tMp("byAuthor", { author: item.author }) : item.repository}
          {typeof item.downloads === "number" && (
            <span className="tabular-nums">
              {(item.author ?? item.repository) ? " · " : ""}
              {tMp("installs", { count: item.downloads.toLocaleString() })}
            </span>
          )}
        </span>
      </span>
      {installed && (
        <CheckIcon className="size-3.5 shrink-0 text-emerald-500" aria-label={tMp("installed")} />
      )}
    </button>
  )
})
