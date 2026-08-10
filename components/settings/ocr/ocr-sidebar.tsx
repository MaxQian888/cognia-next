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
import { Eraser, Layers, Search, Sparkles } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import type { OcrProviderCategory } from "@/types/ocr"
import { OcrSidebarItem, type OcrProviderStatus } from "./ocr-sidebar-item"

export const OCR_AUTO_ROUTER_ID = "__auto__"
export const OCR_COMPARE_ID = "__compare__"

export type OcrCategoryFilter = "all" | OcrProviderCategory

export interface OcrSidebarProvider {
  id: string
  name: string
  subtitle: string
  status: OcrProviderStatus
  /** Mirrors OcrProvider.category — drives the "All" grouping. */
  category: OcrProviderCategory
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

const CATEGORY_ORDER: ReadonlyArray<OcrProviderCategory> = [
  "document-cloud",
  "llm-vision",
  "specialist",
  "lark",
  "local",
]

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

      {/* 3 + 4. Pinned entries + scrollable list */}
      <div
        className="flex-1 overflow-x-hidden overflow-y-auto p-1"
        role="list"
        aria-label={t("ocr.sidebar.mobileTrigger")}
      >
        {/* Compare pinned item */}
        <PinnedRow
          isSelected={selectedId === OCR_COMPARE_ID}
          onClick={() => onSelect(OCR_COMPARE_ID)}
          icon={<Layers className="h-4 w-4" aria-hidden="true" />}
          label={t("ocr.compare.sidebarLabel")}
          subtitle={t("ocr.compare.sidebarSubtitle")}
          testId="ocr-compare-item"
        />

        {/* Auto-Router pinned item */}
        <PinnedRow
          isSelected={selectedId === OCR_AUTO_ROUTER_ID}
          onClick={() => onSelect(OCR_AUTO_ROUTER_ID)}
          icon={<Sparkles className="h-4 w-4" aria-hidden="true" />}
          label={t("ocr.autoRouter.label")}
          subtitle={autoRouterSubtitle}
          badge={t("ocr.autoRouter.defaultBadge")}
          testId="ocr-auto-router-item"
        />

        {categoryFilter === "all"
          ? renderGroupedProviders(providers, selectedId, onSelect, t)
          : providers.map((p) => (
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

interface PinnedRowProps {
  isSelected: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
  subtitle: string
  badge?: string
  testId: string
}

function PinnedRow({ isSelected, onClick, icon, label, subtitle, badge, testId }: PinnedRowProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      data-testid={testId}
      className={cn(
        "h-auto w-full justify-start gap-3 whitespace-normal rounded-lg px-3 py-2.5 text-left font-normal transition-all duration-200",
        isSelected
          ? "border-l-2 border-l-primary bg-primary text-primary-foreground"
          : "hover:bg-muted/50"
      )}
    >
      <div
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
          isSelected ? "bg-primary-foreground/20" : "bg-muted"
        )}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{label}</span>
        <span
          className={cn(
            "block truncate text-xs",
            isSelected ? "text-primary-foreground/70" : "text-muted-foreground"
          )}
        >
          {subtitle}
        </span>
      </div>
      {badge && (
        <Badge
          variant="outline"
          className={cn(
            "shrink-0 text-[10px] px-1.5 py-0",
            isSelected &&
              "bg-primary-foreground/20 text-primary-foreground border-primary-foreground/30"
          )}
        >
          {badge}
        </Badge>
      )}
    </Button>
  )
}

function renderGroupedProviders(
  providers: readonly OcrSidebarProvider[],
  selectedId: string | null,
  onSelect: (id: string) => void,
  t: ReturnType<typeof useTranslations>
): React.ReactNode {
  const groups = new Map<OcrProviderCategory, OcrSidebarProvider[]>()
  for (const cat of CATEGORY_ORDER) groups.set(cat, [])
  for (const p of providers) {
    const list = groups.get(p.category)
    if (list) list.push(p)
  }
  const out: React.ReactNode[] = []
  for (const cat of CATEGORY_ORDER) {
    const list = groups.get(cat) ?? []
    if (list.length === 0) continue
    out.push(
      <div
        key={`hdr-${cat}`}
        className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
        data-testid={`ocr-sidebar-group-${cat}`}
      >
        {t(`ocr.categories.${cat}`)}
      </div>
    )
    for (const p of list) {
      out.push(
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
      )
    }
  }
  return out
}
