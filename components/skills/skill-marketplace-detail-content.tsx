"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Streamdown } from "streamdown"
import { CheckIcon, DownloadIcon, ExternalLinkIcon } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { fetchMarketplaceContent } from "@/lib/skills/marketplace-install"
import { getCategoryMeta } from "@/lib/skills/categories"
import type { MarketplaceItem } from "@/lib/skills/marketplace-types"
import type { AuditEntry, FileTreeEntry } from "@/hooks/skills"
import { SkillAuditBadges } from "./skill-audit-badges"
import { SkillFilePreview } from "./skill-file-preview"
import { loggers } from "@cognia/logging"

interface Props {
  item: MarketplaceItem
  installed: boolean
  installing: boolean
  onInstall: (item: MarketplaceItem) => void
  onUninstall: (item: MarketplaceItem) => void
  /** Lazily-fetched skills.sh extras; undefined until the parent fetches. */
  audit?: AuditEntry
  fileTree?: FileTreeEntry
  onNeedAudit?: (item: MarketplaceItem) => void
  onNeedFileTree?: (item: MarketplaceItem) => void
}

/**
 * Sheet-agnostic marketplace item detail: header meta, badges,
 * install/uninstall actions, and the fetched readme. Rendered inline in the
 * Browse master-detail right pane (desktop) and inside
 * `SkillMarketplaceDetail`'s Sheet (mobile).
 */
export function SkillMarketplaceDetailContent({
  item,
  installed,
  installing,
  onInstall,
  onUninstall,
  audit,
  fileTree,
  onNeedAudit,
  onNeedFileTree,
}: Props) {
  const t = useTranslations("skills")
  const tMp = useTranslations("skills.marketplace")
  const cat = getCategoryMeta(item.category)
  const Icon = cat.icon
  const [readme, setReadme] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const isSkillsSh = item.source === "skillssh"

  // Lazily trigger the audit + file-manifest fetches when a skills.sh item
  // is shown; the hook caches per item id so repeat selections are free.
  useEffect(() => {
    if (!isSkillsSh) return
    onNeedAudit?.(item)
    onNeedFileTree?.(item)
  }, [isSkillsSh, item, onNeedAudit, onNeedFileTree])

  useEffect(() => {
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting fetch state when item changes
    setLoading(true)
    setError(null)
    setReadme(null)
    fetchMarketplaceContent(item)
      .then((res) => {
        if (!cancelled) setReadme(res.content)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
        loggers.skills.error("marketplace fetch content failed", err, {
          itemId: item.id,
          source: item.source,
          sourceId: item.sourceId,
        })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [item])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b px-5 py-4">
        <div className="flex items-center gap-2 text-base font-semibold">
          <span className={`flex h-8 w-8 items-center justify-center rounded-md ${cat.color}`}>
            <Icon className="size-4" />
          </span>
          <span className="truncate">{item.name}</span>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {item.author && tMp("byAuthor", { author: item.author })}
          {item.author && item.repository && " · "}
          {item.repository && (
            <a
              href={
                item.repository.startsWith("http")
                  ? item.repository
                  : `https://github.com/${item.repository}`
              }
              target="_blank"
              rel="noreferrer"
              className="underline-offset-2 hover:underline"
            >
              <ExternalLinkIcon className="mr-0.5 inline size-3" />
              {item.repository}
            </a>
          )}
        </p>
      </div>

      <div className="shrink-0 border-b bg-muted/20 px-5 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary" className="h-5 text-[10px]">
            {item.source === "registry" ? tMp("sourceRegistry") : tMp("sourceSkillssh")}
          </Badge>
          {typeof item.downloads === "number" && (
            <Badge variant="outline" className="h-5 text-[10px] tabular-nums">
              {tMp("installs", { count: item.downloads.toLocaleString() })}
            </Badge>
          )}
          <Badge variant="outline" className="h-5 text-[10px]">
            {t(`category.${cat.labelKey}` as never)}
          </Badge>
          {item.license && (
            <Badge variant="outline" className="h-5 text-[10px]">
              {tMp("license", { name: item.license })}
            </Badge>
          )}
          {(item.tags ?? []).map((tag) => (
            <Badge key={tag} variant="outline" className="h-5 text-[10px]">
              {tag}
            </Badge>
          ))}
        </div>
        {item.description && (
          <p className="mt-2 text-xs text-muted-foreground">{item.description}</p>
        )}
        {isSkillsSh && (
          <div className="mt-3 space-y-3">
            <SkillAuditBadges audit={audit} />
            <SkillFilePreview files={fileTree} />
          </div>
        )}
        <div className="mt-3 flex items-center gap-2">
          {installed ? (
            <Button
              size="sm"
              variant="outline"
              className="min-h-11 md:min-h-8"
              onClick={() => onUninstall(item)}
              disabled={installing}
            >
              {installing ? (
                <Spinner className="mr-1.5 size-3" />
              ) : (
                <CheckIcon className="mr-1.5 size-3.5" />
              )}
              {tMp("uninstall")}
            </Button>
          ) : (
            <Button
              size="sm"
              className="min-h-11 md:min-h-8"
              onClick={() => onInstall(item)}
              disabled={installing}
            >
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

      <ScrollArea className="min-h-0 flex-1">
        <div className="prose prose-sm dark:prose-invert max-w-none px-5 py-4">
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner className="size-3" /> {tMp("loading")}
            </div>
          ) : error ? (
            <p className="text-xs text-destructive">{error}</p>
          ) : readme ? (
            <Streamdown>{readme}</Streamdown>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  )
}
