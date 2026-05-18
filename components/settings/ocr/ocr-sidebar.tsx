"use client"

/**
 * OCR sidebar — sibling of `components/settings/provider/provider-sidebar.tsx`.
 *
 * Layout:
 *   1. Search input (no add button — OCR providers are built-in)
 *   2. Category Tabs — All / Document / LLM Vision / Specialist / Lark / Local
 *   3. Auto-Router pinned item — never filtered
 *   4. Scrollable provider list
 *   5. "Clear OCR cache" footer (replaces the model-provider Compare button)
 *   6. Stats row
 */

import React from "react"
import { useTranslations } from "next-intl"
import { Eraser, Search, Sparkles } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import type { OcrProviderCategory } from "@/lib/ocr/types"
import { OcrSidebarItem, type OcrProviderStatus } from "./ocr-sidebar-item"

export const OCR_AUTO_ROUTER_ID = "__auto__"

export type OcrCategoryFilter = "all" | OcrProviderCategory

export interface OcrSidebarProvider {
  id: string
  name: string
  subtitle: string
  status: OcrProviderStatus
  disabled?: boolean
}

interface OcrSidebarProps {
  providers: OcrSidebarProvider[]
  autoRouterSubtitle: string
  selectedId: string | null
  onSelect: (id: string) => void
  searchQuery: string
  onSearchChange: (q: string) => void
  categoryFilter: OcrCategoryFilter
  onCategoryChange: (c: OcrCategoryFilter) => void
  onClearCache: () => void | Promise<void>
  stats: { enabled: number; local: number; cloud: number }
}

const CATEGORY_TABS: ReadonlyArray<OcrCategoryFilter> = [
  "all",
  "document-cloud",
  "llm-vision",
  "specialist",
  "lark",
  "local",
]

export function OcrSidebar({
  providers,
  autoRouterSubtitle,
  selectedId,
  onSelect,
  searchQuery,
  onSearchChange,
  categoryFilter,
  onCategoryChange,
  onClearCache,
  stats,
}: OcrSidebarProps) {
  const t = useTranslations()

  return (
    <div className="flex h-full w-full min-w-0 flex-col overflow-hidden">
      {/* 1. Search */}
      <div className="flex min-w-0 gap-2 border-b p-3">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder={t("ocr.sidebar.searchPlaceholder")}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            aria-label={t("ocr.sidebar.searchPlaceholder")}
          />
        </div>
      </div>

      {/* 2. Category Tabs */}
      <div className="min-w-0 border-b px-3 py-2">
        <Tabs
          value={categoryFilter}
          onValueChange={(v) => onCategoryChange(v as OcrCategoryFilter)}
          className="min-w-0"
        >
          <TabsList className="h-8 w-full">
            {CATEGORY_TABS.map((tab) => (
              <TabsTrigger key={tab} value={tab} className="min-w-0 text-xs">
                {tab === "all" ? t("ocr.sidebar.categoryAll") : t(`ocr.categories.${tab}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      {/* 3 + 4. Auto-Router + scrollable list */}
      <div
        className="flex-1 overflow-x-hidden overflow-y-auto p-1"
        role="list"
        aria-label="OCR providers"
      >
        {/* Auto-Router pinned item */}
        <button
          type="button"
          onClick={() => onSelect(OCR_AUTO_ROUTER_ID)}
          data-testid="ocr-auto-router-item"
          className={cn(
            "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-all duration-200",
            selectedId === OCR_AUTO_ROUTER_ID
              ? "border-l-2 border-l-primary bg-primary text-primary-foreground"
              : "hover:bg-muted/50"
          )}
        >
          <div
            className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
              selectedId === OCR_AUTO_ROUTER_ID ? "bg-primary-foreground/20" : "bg-muted"
            )}
          >
            <Sparkles className="h-4 w-4" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{t("ocr.autoRouter.label")}</span>
            <span
              className={cn(
                "block truncate text-xs",
                selectedId === OCR_AUTO_ROUTER_ID
                  ? "text-primary-foreground/70"
                  : "text-muted-foreground"
              )}
            >
              {autoRouterSubtitle}
            </span>
          </div>
          <Badge
            variant="outline"
            className={cn(
              "shrink-0 text-[10px] px-1.5 py-0",
              selectedId === OCR_AUTO_ROUTER_ID &&
                "bg-primary-foreground/20 text-primary-foreground border-primary-foreground/30"
            )}
          >
            {t("ocr.autoRouter.defaultBadge")}
          </Badge>
        </button>

        {providers.map((p) => (
          <OcrSidebarItem
            key={p.id}
            providerId={p.id}
            name={p.name}
            subtitle={p.subtitle}
            status={p.status}
            disabled={p.disabled}
            isSelected={p.id === selectedId}
            onClick={onSelect}
            statusLabel={t(`ocr.status.${statusKey(p.status)}`)}
          />
        ))}
      </div>

      {/* 5. Clear cache footer */}
      <div className="min-w-0 border-t px-3 py-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void onClearCache()}
          className="w-full justify-start"
        >
          <Eraser className="mr-2 h-4 w-4" />
          {t("ocr.sidebar.clearCache")}
        </Button>
      </div>

      {/* 6. Stats row */}
      <div className="min-w-0 border-t px-3 py-2 text-xs text-muted-foreground">
        {t("ocr.sidebar.stats", stats)}
      </div>
    </div>
  )
}

function statusKey(status: OcrProviderStatus): string {
  switch (status) {
    case "not-configured":
      return "notConfigured"
    default:
      return status
  }
}
