"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { RefreshCwIcon, SearchIcon, ShoppingBagIcon } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { useSkillMarketplace, type MarketplaceSourceFilter } from "@/hooks/skills"
import { useIsMobile } from "@/hooks/ui/use-mobile"
import type { MarketplaceItem } from "@/lib/skills/marketplace-types"
import { SkillMarketplaceListItem } from "./skill-marketplace-list-item"
import { SkillMarketplaceDetail } from "./skill-marketplace-detail"
import { SkillMarketplaceDetailContent } from "./skill-marketplace-detail-content"
import { SkillMarketplaceEmpty } from "./skill-marketplace-empty"
import { loggers } from "@/lib/logging"

export function SkillMarketplace() {
  const t = useTranslations("skills.marketplace")
  const tCommon = useTranslations("skills")
  const tToasts = useTranslations("skills.toasts")
  const m = useSkillMarketplace()
  const isMobile = useIsMobile()
  const [pickedItem, setPickedItem] = useState<MarketplaceItem | null>(null)

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

  const showSkillsMpHint = !m.isSkillsMpEnabled && (m.source === "skillsmp" || m.source === "all")
  const isInstalled = (item: MarketplaceItem) => m.installed.has(`${item.source}:${item.sourceId}`)

  const rightPane = m.state.loading ? (
    <div className="flex flex-1 items-center justify-center gap-2 p-12 text-xs text-muted-foreground">
      <Spinner className="size-3.5" />
      {t("loading")}
    </div>
  ) : m.state.error ? (
    <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-destructive">
      {t("errorLoad", { error: m.state.error })}
    </div>
  ) : !m.isSkillsMpEnabled && m.state.items.length === 0 ? (
    <SkillMarketplaceEmpty />
  ) : m.state.items.length === 0 ? (
    <div className="flex flex-1 items-center justify-center p-12 text-center text-xs text-muted-foreground">
      {t("empty")}
    </div>
  ) : selectedItem ? (
    <SkillMarketplaceDetailContent
      item={selectedItem}
      installed={isInstalled(selectedItem)}
      installing={m.installingId === selectedItem.id}
      onInstall={(it) => void handleInstall(it)}
      onUninstall={(it) => void handleUninstall(it)}
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
      {/* ── Left: search + source filter + item list ─────────────────── */}
      <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border">
        <div className="flex shrink-0 items-center gap-2 border-b p-3">
          <div className="relative flex-1">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={m.query}
              onChange={(e) => m.setQuery(e.target.value)}
              placeholder={tCommon("searchPlaceholder")}
              className="h-9 pl-8 text-xs"
            />
          </div>
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
            <ToggleGroupItem value="skillsmp" className="text-xs" disabled={!m.isSkillsMpEnabled}>
              {t("sourceSkillsmp")}
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        {showSkillsMpHint && (
          <div className="shrink-0 border-b bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
            {t("configureSkillsmp")}
          </div>
        )}
        <div
          className="flex-1 overflow-y-auto p-1"
          aria-label={t("listAriaLabel")}
          data-testid="skill-marketplace-list"
        >
          {m.state.loading ? (
            <div className="flex items-center justify-center gap-2 p-8 text-xs text-muted-foreground">
              <Spinner className="size-3.5" />
              {t("loading")}
            </div>
          ) : (
            m.state.items.map((item) => (
              <SkillMarketplaceListItem
                key={item.id}
                item={item}
                installed={isInstalled(item)}
                active={selectedItem?.id === item.id}
                onSelect={setPickedItem}
              />
            ))
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
        />
      )}
    </div>
  )
}
