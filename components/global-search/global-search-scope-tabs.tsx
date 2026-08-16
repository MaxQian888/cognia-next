"use client"

/**
 * Scope tab row (ADR-0129): All · Chats · Messages · Commands · Pages · People
 * · Library. A `role="tablist"` of pills; the dialog owns keyboard cycling
 * (Tab / Shift+Tab, Alt+1…7) so the input never loses focus.
 */

import { useTranslations } from "next-intl"

import { GLOBAL_SEARCH_SCOPES, type GlobalSearchScope } from "@/lib/global-search/types"
import { cn } from "@/lib/utils"

export interface GlobalSearchScopeTabsProps {
  value: GlobalSearchScope
  onChange: (scope: GlobalSearchScope) => void
  /** Optional per-scope hit counts shown as a small suffix. */
  counts?: Partial<Record<GlobalSearchScope, number>>
  className?: string
}

export function GlobalSearchScopeTabs({
  value,
  onChange,
  counts,
  className,
}: GlobalSearchScopeTabsProps) {
  const t = useTranslations("globalSearch")
  return (
    <div
      role="tablist"
      aria-label={t("footer.scopes")}
      className={cn(
        "flex items-center gap-1 overflow-x-auto px-3 py-2 [scrollbar-width:none]",
        className
      )}
      data-testid="global-search-scope-tabs"
    >
      {GLOBAL_SEARCH_SCOPES.map((scope, index) => {
        const active = scope === value
        const count = counts?.[scope]
        return (
          <button
            key={scope}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={-1}
            data-scope={scope}
            data-state={active ? "active" : "inactive"}
            aria-keyshortcuts={`Alt+${index + 1}`}
            // Never steal focus from the input: the tab is a pointer target only.
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => onChange(scope)}
            className={cn(
              "flex h-6 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs transition-colors",
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            <span>{t(`scopes.${scope}`)}</span>
            {count !== undefined && count > 0 ? (
              <span className={cn("tabular-nums", active ? "opacity-80" : "opacity-60")}>
                {count}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

/** Next scope in tab order (wraps). */
export function cycleScope(current: GlobalSearchScope, delta: 1 | -1): GlobalSearchScope {
  const index = GLOBAL_SEARCH_SCOPES.indexOf(current)
  const next = (index + delta + GLOBAL_SEARCH_SCOPES.length) % GLOBAL_SEARCH_SCOPES.length
  return GLOBAL_SEARCH_SCOPES[next]!
}

/** Scope for an `Alt+<digit>` chord, or null when the digit is out of range. */
export function scopeForDigit(digit: number): GlobalSearchScope | null {
  return GLOBAL_SEARCH_SCOPES[digit - 1] ?? null
}
