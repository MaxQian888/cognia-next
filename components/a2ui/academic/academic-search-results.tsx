"use client"

/**
 * AcademicSearchResults - A2UI component for displaying search results
 * Renders a list of papers with filters and pagination
 */

import React, { useState, useCallback } from "react"
import { useTranslations } from "next-intl"
import { Search, Loader2, SlidersHorizontal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { isWebHref, safeA2UIHref } from "@/lib/a2ui/url-policy"
import { openExternal } from "@/lib/tauri/opener"
import type { Paper, AcademicProviderType } from "@/types/academic"
import { AcademicPaperCard } from "./academic-paper-card"

/**
 * A paper's `pdfUrl` comes from search results a model or provider supplied,
 * so only a web URL opens (ADR-0240), and it opens the way every shell opens
 * an outbound link: `window.open` does nothing useful under Tauri.
 */
function openPaperPdf(url: string): void {
  const href = safeA2UIHref(url)
  if (href && isWebHref(href)) void openExternal(href)
}

export interface AcademicSearchResultsProps {
  papers: Paper[]
  query: string
  totalResults: number
  isLoading?: boolean
  providerResults?: Record<string, { count: number; success: boolean }>
  onPaperSelect?: (paper: Paper) => void
  onAddToLibrary?: (paper: Paper) => void
  onAnalyzePaper?: (paper: Paper) => void
  onLoadMore?: () => void
  onFilterChange?: (filters: SearchFilters) => void
  hasMore?: boolean
  className?: string
}

export interface SearchFilters {
  provider?: AcademicProviderType | "all"
  yearFrom?: number
  yearTo?: number
  sortBy?: "relevance" | "date" | "citations"
  openAccessOnly?: boolean
}

export function AcademicSearchResults({
  papers,
  query,
  totalResults,
  isLoading = false,
  providerResults,
  onPaperSelect,
  onAddToLibrary,
  onAnalyzePaper,
  onLoadMore,
  onFilterChange,
  hasMore = false,
  className,
}: AcademicSearchResultsProps) {
  const t = useTranslations("a2ui")
  const [filters, setFilters] = useState<SearchFilters>({
    provider: "all",
    sortBy: "relevance",
    openAccessOnly: false,
  })

  const handleFilterChange = useCallback(
    (key: keyof SearchFilters, value: unknown) => {
      const newFilters = { ...filters, [key]: value }
      setFilters(newFilters)
      onFilterChange?.(newFilters)
    },
    [filters, onFilterChange]
  )

  const successfulProviders = providerResults
    ? Object.entries(providerResults)
        .filter(([, r]) => r.success)
        .map(([provider, r]) => ({ provider, count: r.count }))
    : []

  return (
    <div className={cn("flex flex-col h-full", className)}>
      <div className="flex items-center gap-2 px-4 py-3 border-b">
        <Search className="h-4 w-4 text-muted-foreground" />
        <span className="font-medium">{t("searchResultsFor", { query })}</span>
        <Badge variant="secondary" className="ml-auto">
          {t("searchPapersCount", { count: totalResults })}
        </Badge>
      </div>

      <div className="flex items-center gap-2 px-4 py-2 border-b bg-muted/30">
        <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />

        <Select
          value={filters.provider || "all"}
          onValueChange={(v) => handleFilterChange("provider", v)}
        >
          <SelectTrigger className="w-36 h-8 text-xs">
            <SelectValue placeholder={t("allSources")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("allSources")}</SelectItem>
            <SelectItem value="arxiv">{/* i18n-exempt: provider brand name */ "arXiv"}</SelectItem>
            <SelectItem value="semantic-scholar">
              {/* i18n-exempt: provider brand name */ "Semantic Scholar"}
            </SelectItem>
            <SelectItem value="openalex">
              {/* i18n-exempt: provider brand name */ "OpenAlex"}
            </SelectItem>
            <SelectItem value="huggingface-papers">
              {/* i18n-exempt: provider brand name */ "HuggingFace"}
            </SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={filters.sortBy || "relevance"}
          onValueChange={(v) => handleFilterChange("sortBy", v as SearchFilters["sortBy"])}
        >
          <SelectTrigger className="w-32 h-8 text-xs">
            <SelectValue placeholder={t("searchSortByPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="relevance">{t("searchSortRelevance")}</SelectItem>
            <SelectItem value="date">{t("searchSortNewest")}</SelectItem>
            <SelectItem value="citations">{t("searchSortCitations")}</SelectItem>
          </SelectContent>
        </Select>

        <Button
          variant={filters.openAccessOnly ? "secondary" : "outline"}
          size="sm"
          className="h-8 text-xs"
          onClick={() => handleFilterChange("openAccessOnly", !filters.openAccessOnly)}
        >
          {t("searchOpenAccess")}
        </Button>

        {successfulProviders.length > 0 && (
          <div className="ml-auto flex gap-1">
            {successfulProviders.map(({ provider, count }) => (
              <Badge key={provider} variant="outline" className="text-[10px]">
                {provider}: {count}
              </Badge>
            ))}
          </div>
        )}
      </div>

      <ScrollArea className="flex-1">
        {isLoading && papers.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            <span className="ml-2 text-muted-foreground">{t("searchingPapers")}</span>
          </div>
        ) : papers.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Search className="h-12 w-12 text-muted-foreground/30 mb-4" />
            <p className="text-muted-foreground">{t("searchNoPapers")}</p>
            <p className="text-sm text-muted-foreground/70">{t("searchNoPapersHint")}</p>
          </div>
        ) : (
          <div className="p-4 space-y-3">
            {papers.map((paper, idx) => (
              <AcademicPaperCard
                key={paper.id || idx}
                paper={paper}
                onViewDetails={onPaperSelect}
                onAddToLibrary={onAddToLibrary}
                onAnalyze={onAnalyzePaper}
                onOpenPdf={openPaperPdf}
              />
            ))}

            {hasMore && (
              <Button
                variant="outline"
                className="w-full mt-4"
                onClick={onLoadMore}
                disabled={isLoading}
              >
                {isLoading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    {t("searchLoading")}
                  </>
                ) : (
                  t("searchLoadMore")
                )}
              </Button>
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
