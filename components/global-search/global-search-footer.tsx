"use client"

/**
 * Dialog footer (ADR-0129): keyboard hints on the left, hit count / timing /
 * coverage on the right, and a syntax cheat-sheet behind a "?" popover-style
 * tooltip. Every string is i18n; the kbd glyphs are literal keys.
 */

import { CircleHelpIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { GlobalSearchCoverage } from "@/lib/global-search/types"
import { cn } from "@/lib/utils"

export interface GlobalSearchFooterProps {
  /** Total hits for the current query; `null` while showing suggestions. */
  totalHits: number | null
  tookMs: number | null
  coverage: GlobalSearchCoverage
  loading: boolean
  className?: string
}

const SYNTAX_KEYS = [
  "prefixes",
  "in",
  "from",
  "is",
  "after",
  "before",
  "workspace",
  "title",
] as const

export function GlobalSearchFooter({
  totalHits,
  tookMs,
  coverage,
  loading,
  className,
}: GlobalSearchFooterProps) {
  const t = useTranslations("globalSearch")
  return (
    <div
      className={cn(
        "flex flex-col gap-1 border-t px-3 py-1.5 text-[11px] text-muted-foreground",
        className
      )}
      data-testid="global-search-footer"
    >
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1">
          <KbdGroup>
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
          </KbdGroup>
          {t("footer.navigate")}
        </span>
        <span className="flex items-center gap-1">
          <Kbd>↵</Kbd>
          {t("footer.open")}
        </span>
        <span className="hidden items-center gap-1 sm:flex">
          {/* i18n-exempt: keyboard key legend */}
          <Kbd>Tab</Kbd>
          {t("footer.scopes")}
        </span>
        <span className="hidden items-center gap-1 sm:flex">
          {/* i18n-exempt: keyboard key legend */}
          <Kbd>Esc</Kbd>
          {t("footer.close")}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t("footer.syntax")}
              onPointerDown={(event) => event.preventDefault()}
              className="flex items-center gap-1 rounded-sm hover:text-foreground"
              data-testid="global-search-syntax-help"
            >
              <CircleHelpIcon className="size-3.5" aria-hidden />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" align="start" className="max-w-xs">
            <ul className="space-y-0.5 text-[11px]">
              {SYNTAX_KEYS.map((key) => (
                <li key={key}>{t(`syntax.${key}`)}</li>
              ))}
            </ul>
          </TooltipContent>
        </Tooltip>
        <span className="ml-auto flex items-center gap-2 tabular-nums" aria-live="polite">
          {loading ? (
            <span>{t("loading")}</span>
          ) : totalHits !== null ? (
            <>
              <span data-testid="global-search-result-count">
                {t("footer.results", { count: totalHits })}
              </span>
              {tookMs !== null ? (
                <span className="opacity-60">{t("footer.took", { ms: tookMs })}</span>
              ) : null}
            </>
          ) : null}
        </span>
      </div>
      {coverage !== "complete" && !loading ? (
        <div
          className="text-[11px] text-amber-600 dark:text-amber-400"
          data-testid="global-search-coverage"
        >
          {coverage === "indexing" ? t("footer.coverageIndexing") : t("footer.coveragePartial")}
        </div>
      ) : null}
    </div>
  )
}
