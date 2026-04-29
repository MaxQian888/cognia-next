"use client"

import { useTranslations } from "next-intl"
import { CheckIcon, DownloadIcon, ExternalLinkIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Spinner } from "@/components/ui/spinner"
import { getCategoryMeta } from "@/lib/skills/categories"
import type { MarketplaceItem } from "@/lib/skills/marketplace-types"

interface Props {
  item: MarketplaceItem
  installed: boolean
  installing: boolean
  onInstall: (item: MarketplaceItem) => void
  onUninstall: (item: MarketplaceItem) => void
  onOpen: (item: MarketplaceItem) => void
}

export function SkillMarketplaceCard({
  item,
  installed,
  installing,
  onInstall,
  onUninstall,
  onOpen,
}: Props) {
  const t = useTranslations("skills")
  const tMp = useTranslations("skills.marketplace")
  const cat = getCategoryMeta(item.category)
  const Icon = cat.icon

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-start gap-3">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md ${cat.color}`}
        >
          <Icon className="size-5" />
        </div>
        <button type="button" onClick={() => onOpen(item)} className="min-w-0 flex-1 text-left">
          <p className="truncate text-sm font-semibold">{item.name}</p>
          {item.author && (
            <p className="text-[11px] text-muted-foreground">
              {tMp("byAuthor", { author: item.author })}
            </p>
          )}
        </button>
        {(item.stars !== undefined || item.downloads !== undefined) && (
          <div className="flex shrink-0 flex-col items-end gap-0.5 text-[10px] text-muted-foreground">
            {item.stars !== undefined && <span>{tMp("stars", { count: item.stars })}</span>}
            {item.downloads !== undefined && (
              <span>{tMp("downloads", { count: item.downloads })}</span>
            )}
          </div>
        )}
      </div>

      {item.description && (
        <p className="line-clamp-3 text-xs text-muted-foreground">{item.description}</p>
      )}

      <div className="flex flex-wrap items-center gap-1">
        <Badge variant="secondary" className="h-5 text-[10px]">
          {item.source === "registry" ? tMp("sourceRegistry") : tMp("sourceSkillsmp")}
        </Badge>
        <Badge variant="outline" className="h-5 text-[10px]">
          {t(`category.${cat.labelKey}` as never)}
        </Badge>
        {(item.tags ?? []).slice(0, 3).map((tag) => (
          <Badge key={tag} variant="outline" className="h-5 text-[10px]">
            {tag}
          </Badge>
        ))}
      </div>

      <div className="flex items-center justify-between gap-2 pt-1">
        {item.repository && (
          <a
            href={
              item.repository.startsWith("http")
                ? item.repository
                : `https://github.com/${item.repository}`
            }
            target="_blank"
            rel="noreferrer"
            className="text-[11px] text-muted-foreground hover:underline"
          >
            <ExternalLinkIcon className="mr-1 inline size-3" />
            {item.repository}
          </a>
        )}
        <div className="ml-auto">
          {installed ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onUninstall(item)}
              disabled={installing}
            >
              {installing ? (
                <Spinner className="size-3" />
              ) : (
                <CheckIcon className="mr-1.5 size-3.5 text-emerald-500" />
              )}
              {tMp("installed")}
            </Button>
          ) : (
            <Button size="sm" onClick={() => onInstall(item)} disabled={installing}>
              {installing ? (
                <Spinner className="mr-1.5 size-3" />
              ) : (
                <DownloadIcon className="mr-1.5 size-3.5" />
              )}
              {installing ? tMp("installing") : tMp("install")}
            </Button>
          )}
        </div>
      </div>
    </Card>
  )
}
