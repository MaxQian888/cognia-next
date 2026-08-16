"use client"

/**
 * Active filter tokens as removable chips (ADR-0129). Purely a projection of
 * the parsed query — removing a chip rewrites the raw string through
 * `removeFilterToken`, so the input stays the single source of truth.
 */

import { XIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import type { ParsedFilterToken } from "@/lib/global-search/types"
import { cn } from "@/lib/utils"

export interface GlobalSearchFilterChipsProps {
  tokens: readonly ParsedFilterToken[]
  onRemove: (token: ParsedFilterToken) => void
  className?: string
}

/** Human label for a token key; unknown keys fall back to the raw key. */
export function filterKeyLabel(key: string, t: (key: string) => string): string {
  switch (key) {
    case "in":
    case "from":
    case "is":
    case "after":
    case "before":
    case "workspace":
    case "title":
      return t(`filters.${key}`)
    default:
      return key
  }
}

export function GlobalSearchFilterChips({
  tokens,
  onRemove,
  className,
}: GlobalSearchFilterChipsProps) {
  const t = useTranslations("globalSearch")
  if (tokens.length === 0) return null
  return (
    <div
      className={cn("flex flex-wrap items-center gap-1 px-3 pb-2", className)}
      data-testid="global-search-filter-chips"
    >
      {tokens.map((token, index) => {
        const label = filterKeyLabel(token.key, (key) => t(key as never))
        const text = token.key === "title" ? label : `${label}: ${token.value}`
        return (
          <span
            key={`${token.key}:${token.value}:${index}`}
            className="flex h-5 items-center gap-1 rounded-full border border-border bg-muted/50 pl-2 pr-1 text-[11px] text-muted-foreground"
            data-testid="global-search-filter-chip"
          >
            <span>{text}</span>
            <button
              type="button"
              aria-label={t("filters.remove", { filter: text })}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => onRemove(token)}
              className="rounded-full p-0.5 hover:bg-muted hover:text-foreground"
            >
              <XIcon className="size-3" aria-hidden />
            </button>
          </span>
        )
      })}
    </div>
  )
}
