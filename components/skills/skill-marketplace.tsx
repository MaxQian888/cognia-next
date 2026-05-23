"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { motion, useReducedMotion } from "motion/react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { RefreshCwIcon, SearchIcon, ShoppingBagIcon } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { useSkillMarketplace, type MarketplaceSourceFilter } from "@/hooks/skills"
import type { MarketplaceItem } from "@/lib/skills/marketplace-types"
import { STAGGER_CHILD, STAGGER_CONTAINER } from "@/lib/ui/motion"
import { SkillMarketplaceCard } from "./skill-marketplace-card"
import { SkillMarketplaceDetail } from "./skill-marketplace-detail"
import { SkillMarketplaceEmpty } from "./skill-marketplace-empty"
import { loggers } from "@/lib/logging"

export function SkillMarketplace() {
  const t = useTranslations("skills.marketplace")
  const tCommon = useTranslations("skills")
  const tToasts = useTranslations("skills.toasts")
  const m = useSkillMarketplace()
  const [openItem, setOpenItem] = useState<MarketplaceItem | null>(null)

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
  const reduce = useReducedMotion()

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2 sm:px-4 sm:py-3">
        <div className="flex items-center gap-2">
          <ShoppingBagIcon className="size-4" />
          <h2 className="text-sm font-semibold">{t("title")}</h2>
        </div>
        <div className="order-last w-full md:order-none md:ml-2 md:w-auto md:flex-1">
          <ToggleGroup
            type="single"
            value={m.source}
            onValueChange={(v) => v && m.setSource(v as MarketplaceSourceFilter)}
            size="sm"
            className="w-full md:w-auto md:justify-start"
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
        <div className="relative w-full flex-1 sm:w-48 md:w-64 md:flex-none">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={m.query}
            onChange={(e) => m.setQuery(e.target.value)}
            placeholder={tCommon("searchPlaceholder")}
            className="h-8 pl-8 text-xs"
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

      {showSkillsMpHint && (
        <div className="border-b bg-muted/30 px-4 py-2 text-[11px] text-muted-foreground">
          {t("configureSkillsmp")}
        </div>
      )}

      <ScrollArea className="flex-1">
        {m.state.loading ? (
          <div className="flex items-center justify-center gap-2 p-12 text-xs text-muted-foreground">
            <Spinner className="size-3.5" />
            {t("loading")}
          </div>
        ) : m.state.error ? (
          <div className="p-6 text-center text-xs text-destructive">
            {t("errorLoad", { error: m.state.error })}
          </div>
        ) : !m.isSkillsMpEnabled && m.state.items.length === 0 ? (
          <SkillMarketplaceEmpty />
        ) : m.state.items.length === 0 ? (
          <div className="p-12 text-center text-xs text-muted-foreground">{t("empty")}</div>
        ) : (
          <motion.div
            className="grid grid-cols-1 gap-3 p-3 sm:p-4 md:grid-cols-2 xl:grid-cols-3"
            initial={reduce ? false : "initial"}
            animate="animate"
            variants={STAGGER_CONTAINER}
            data-testid="skill-marketplace-grid"
          >
            {m.state.items.map((item) => (
              <motion.div key={item.id} variants={STAGGER_CHILD}>
                <SkillMarketplaceCard
                  item={item}
                  installed={m.installed.has(`${item.source}:${item.sourceId}`)}
                  installing={m.installingId === item.id}
                  onInstall={(it) => void handleInstall(it)}
                  onUninstall={(it) => void handleUninstall(it)}
                  onOpen={setOpenItem}
                />
              </motion.div>
            ))}
          </motion.div>
        )}
      </ScrollArea>

      {openItem && (
        <SkillMarketplaceDetail
          item={openItem}
          installed={m.installed.has(`${openItem.source}:${openItem.sourceId}`)}
          installing={m.installingId === openItem.id}
          onClose={() => setOpenItem(null)}
          onInstall={(it) => void handleInstall(it)}
          onUninstall={(it) => void handleUninstall(it)}
        />
      )}
    </div>
  )
}
