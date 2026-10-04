"use client"

/**
 * Dialog footer (ADR-0129): keyboard hints on the left, hit count / timing on
 * the right, and a coverage note underneath. Every string is i18n; the kbd
 * glyphs are literal keys.
 *
 * The search-syntax help lives at the end of the input row
 * (`GlobalSearchSyntaxHelp`), not here, so the footer only exists where it has
 * something to say: in `compact` mode (the full-screen phone layout, where the
 * row would sit right on top of the soft keyboard) it keeps just the coverage
 * warning and renders nothing at all when there is none.
 */

import { useTranslations } from "next-intl"

import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { useShowKeyboardHints } from "@/hooks/ui/use-pointer"
import type { GlobalSearchCoverage } from "@/lib/global-search/types"
import { cn } from "@/lib/utils"

export interface GlobalSearchFooterProps {
  /** Total hits for the current query; `null` while showing suggestions. */
  totalHits: number | null
  tookMs: number | null
  coverage: GlobalSearchCoverage
  loading: boolean
  /**
   * Phone layout: no key legend and no count / timing (the scope tabs carry the
   * counts and the input row the spinner) — only the coverage warning, and no
   * row at all without one.
   */
  compact?: boolean
  className?: string
}

export function GlobalSearchFooter({
  totalHits,
  tookMs,
  coverage,
  loading,
  compact = false,
  className,
}: GlobalSearchFooterProps) {
  const t = useTranslations("globalSearch")
  // Arrow keys, Enter, Tab and Esc do not exist on a phone; the legend is only
  // drawn where a keyboard is.
  const keyboardHintsAvailable = useShowKeyboardHints()
  const showKeyboardHints = keyboardHintsAvailable && !compact
  // The status row hosts the `aria-live` count, so outside compact mode it is
  // always mounted (a live region inserted together with its first message is
  // often not announced).
  const showStatus = !compact
  const showCoverage = coverage !== "complete" && !loading
  // Compact with nothing to warn about: no row at all rather than an empty strip.
  if (!showStatus && !showCoverage) return null
  return (
    <div
      className={cn(
        "flex flex-col gap-1 border-t px-3 py-1.5 text-[11px] text-muted-foreground",
        className
      )}
      data-testid="global-search-footer"
    >
      {showStatus ? (
        <div className="flex items-center gap-3">
          {showKeyboardHints ? (
            <>
              <span className="flex items-center gap-1" data-testid="global-search-key-legend">
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
            </>
          ) : null}
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
      ) : null}
      {showCoverage ? (
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
