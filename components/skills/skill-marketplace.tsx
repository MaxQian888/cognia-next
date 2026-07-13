"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { LinkIcon, RefreshCwIcon, SearchIcon, ShoppingBagIcon } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import {
  useSkillMarketplace,
  type MarketplaceSourceFilter,
  type MarketplaceView,
} from "@/hooks/skills"
import { useIsMobile } from "@/hooks/ui/use-mobile"
import { useSkillsStore } from "@/stores/skills/skills-store"
import type { MarketplaceItem } from "@/lib/skills/marketplace-types"
import { ScrollShadowRow } from "@/components/plugins/scroll-shadow-row"
import { SkillMarketplaceListItem } from "./skill-marketplace-list-item"
import { SkillMarketplaceDetail } from "./skill-marketplace-detail"
import { SkillMarketplaceDetailContent } from "./skill-marketplace-detail-content"
import { SkillMarketplaceTokenTeaser } from "./skill-marketplace-token-teaser"
import { loggers } from "@cognia/logging"

export function SkillMarketplace() {
  const t = useTranslations("skills.marketplace")
  const tCommon = useTranslations("skills")
  const tToasts = useTranslations("skills.toasts")
  const m = useSkillMarketplace()
  const isMobile = useIsMobile()
  const setUrlInstallOpen = useSkillsStore((s) => s.setUrlInstallOpen)
  const [pickedItem, setPickedItem] = useState<MarketplaceItem | null>(null)

  // Reset the picked item when the result context changes (view / source /
  // query), mirroring the plugin-marketplace trackedView prev-compare reset.
  const viewKey = `${m.view}|${m.source}|${m.query}`
  const [trackedView, setTrackedView] = useState(viewKey)
  if (trackedView !== viewKey) {
    setTrackedView(viewKey)
    setPickedItem(null)
  }

  // Effective selection, derived at render time (no effect): on desktop the
  // detail pane is never blank — an explicit pick that survived the latest
  // result set wins (re-pointed at the refreshed object), otherwise the first
  // item is shown. Mobile keeps the raw pick so the Sheet only opens on tap.
  const selectedItem = useMemo(() => {
    if (isMobile || m.state.loading) return pickedItem
    const items = m.state.items
    if (pickedItem) {
      const refreshed = items.find((i) => i.id === pickedItem.id)
      if (refreshed) return refreshed
    }
    return items[0] ?? null
  }, [isMobile, m.state.loading, m.state.items, pickedItem])

  const handleInstall = async (item: MarketplaceItem) => {
    try {
      await m.install(item)
      toast.success(tToasts("installed", { name: item.name }))
      loggers.skills.info("marketplace install ok", {
        itemId: item.id,
        source: item.source,
        sourceId: item.sourceId,
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      loggers.skills.error("marketplace install failed", err, {
        itemId: item.id,
        source: item.source,
        sourceId: item.sourceId,
      })
    }
  }

  const handleUninstall = async (item: MarketplaceItem) => {
    try {
      await m.uninstall(item)
      toast.success(tToasts("uninstalled", { name: item.name }))
      loggers.skills.info("marketplace uninstall ok", {
        itemId: item.id,
        source: item.source,
        sourceId: item.sourceId,
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      loggers.skills.error("marketplace uninstall failed", err, {
        itemId: item.id,
        source: item.source,
        sourceId: item.sourceId,
      })
    }
  }

  const isInstalled = (item: MarketplaceItem) => m.installed.has(`${item.source}:${item.sourceId}`)
  const showTeaser = !m.hasToken && !m.webBlocked && m.view === "search" && !m.query.trim()

  const rightPane = m.state.loading ? (
    <div className="flex flex-1 items-center justify-center gap-2 p-12 text-xs text-muted-foreground">
      <Spinner className="size-3.5" />
      {t("loading")}
    </div>
  ) : m.state.error ? (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-xs">
      <p className="text-destructive">
        {m.state.tokenError ? t("tokenExpired") : t("errorLoad", { error: m.state.error })}
      </p>
      {m.state.tokenError && (
        <Button size="sm" variant="outline" onClick={() => m.setView("search")}>
          {t("views.search")}
        </Button>
      )}
    </div>
  ) : m.state.items.length === 0 ? (
    <div className="flex flex-1 items-center justify-center p-12 text-center text-xs text-muted-foreground">
      {m.view === "search" && m.query.trim().length < 2 && !m.webBlocked
        ? t("searchHint")
        : t("empty")}
    </div>
  ) : selectedItem ? (
    <SkillMarketplaceDetailContent
      item={selectedItem}
      installed={isInstalled(selectedItem)}
      installing={m.installingId === selectedItem.id}
      onInstall={(it) => void handleInstall(it)}
      onUninstall={(it) => void handleUninstall(it)}
      audit={m.audit(selectedItem.id)}
      fileTree={m.fileTree(selectedItem.id)}
      onNeedAudit={m.fetchAudit}
      onNeedFileTree={m.fetchFileTree}
    />
  ) : (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-12 text-center">
      <ShoppingBagIcon className="size-8 text-muted-foreground/40" />
      <p className="text-sm font-medium">{t("selectItemTitle")}</p>
      <p className="text-xs text-muted-foreground">{t("selectItemHint")}</p>
    </div>
  )

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 p-3 sm:gap-4 sm:p-4 md:grid-cols-[320px_1fr]">
      {/* ── Left: search + views + source filter + item list ─────────── */}
      <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border">
        <div className="flex shrink-0 items-center gap-2 border-b p-3">
          <div className="relative flex-1">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={m.query}
              onChange={(e) => {
                m.setQuery(e.target.value)
                if (m.view !== "search") m.setView("search")
              }}
              placeholder={tCommon("searchPlaceholder")}
              className="h-9 pl-8 text-xs"
            />
          </div>
          <Button
            size="icon"
            variant="ghost"
            className="size-8 shrink-0"
            onClick={() => setUrlInstallOpen(true)}
            aria-label={t("urlInstall.open")}
            data-testid="skill-marketplace-url-install"
          >
            <LinkIcon className="size-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-8 shrink-0"
            onClick={() => void m.refresh()}
            disabled={m.state.loading}
            aria-label={tCommon("refresh")}
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
        </div>
        {m.hasToken && !m.webBlocked && (
          <div className="shrink-0 border-b px-3 py-2">
            <ScrollShadowRow>
              <ToggleGroup
                type="single"
                value={m.view}
                onValueChange={(v) => v && m.setView(v as MarketplaceView)}
                size="sm"
                data-testid="skill-marketplace-views"
              >
                <ToggleGroupItem value="search" className="min-h-11 text-xs md:min-h-0">
                  {t("views.search")}
                </ToggleGroupItem>
                <ToggleGroupItem value="all-time" className="min-h-11 text-xs md:min-h-0">
                  {t("views.allTime")}
                </ToggleGroupItem>
                <ToggleGroupItem value="trending" className="min-h-11 text-xs md:min-h-0">
                  {t("views.trending")}
                </ToggleGroupItem>
                <ToggleGroupItem value="hot" className="min-h-11 text-xs md:min-h-0">
                  {t("views.hot")}
                </ToggleGroupItem>
                <ToggleGroupItem value="curated" className="min-h-11 text-xs md:min-h-0">
                  {t("views.curated")}
                </ToggleGroupItem>
              </ToggleGroup>
            </ScrollShadowRow>
          </div>
        )}
        {m.view === "search" && (
          <div className="shrink-0 border-b px-3 py-2">
            <ToggleGroup
              type="single"
              value={m.source}
              onValueChange={(v) => v && m.setSource(v as MarketplaceSourceFilter)}
              size="sm"
              className="w-full"
            >
              <ToggleGroupItem value="all" className="text-xs">
                {t("sourceAll")}
              </ToggleGroupItem>
              <ToggleGroupItem value="registry" className="text-xs">
                {t("sourceRegistry")}
              </ToggleGroupItem>
              <ToggleGroupItem value="skillssh" className="text-xs" disabled={m.webBlocked}>
                {t("sourceSkillssh")}
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        )}
        {m.webBlocked && (
          <div
            className="shrink-0 border-b bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground"
            data-testid="skill-marketplace-web-blocked"
          >
            {t("webBlocked")}
          </div>
        )}
        <div
          className="flex-1 overflow-y-auto p-1"
          aria-label={t("listAriaLabel")}
          data-testid="skill-marketplace-list"
        >
          {showTeaser && <SkillMarketplaceTokenTeaser />}
          {m.state.loading ? (
            <div className="flex items-center justify-center gap-2 p-8 text-xs text-muted-foreground">
              <Spinner className="size-3.5" />
              {t("loading")}
            </div>
          ) : (
            <>
              {m.state.items.map((item) => (
                <SkillMarketplaceListItem
                  key={item.id}
                  item={item}
                  installed={isInstalled(item)}
                  active={selectedItem?.id === item.id}
                  onSelect={setPickedItem}
                />
              ))}
              {m.state.hasMore && (
                <div className="p-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="min-h-11 w-full text-xs md:min-h-9"
                    onClick={() => void m.loadMore()}
                    disabled={m.state.loadingMore}
                    data-testid="skill-marketplace-load-more"
                  >
                    {m.state.loadingMore ? <Spinner className="mr-1.5 size-3" /> : null}
                    {t("loadMore")}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── Right: inline detail (desktop) ───────────────────────────── */}
      {!isMobile && (
        <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border">{rightPane}</div>
      )}

      {/* ── Mobile detail Sheet ──────────────────────────────────────── */}
      {isMobile && selectedItem && (
        <SkillMarketplaceDetail
          item={selectedItem}
          installed={isInstalled(selectedItem)}
          installing={m.installingId === selectedItem.id}
          onClose={() => setPickedItem(null)}
          onInstall={(it) => void handleInstall(it)}
          onUninstall={(it) => void handleUninstall(it)}
          audit={m.audit(selectedItem.id)}
          fileTree={m.fileTree(selectedItem.id)}
          onNeedAudit={m.fetchAudit}
          onNeedFileTree={m.fetchFileTree}
        />
      )}
    </div>
  )
}
