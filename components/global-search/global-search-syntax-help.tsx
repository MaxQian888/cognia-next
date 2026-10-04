"use client"

/**
 * Search-syntax cheat sheet (ADR-0129): a compact "?" icon button at the end
 * of the search input row that opens a popover listing the `>` / `@` prefixes
 * and the `in:` / `from:` / `is:` / … filters.
 *
 * A Popover, not a Tooltip: a tooltip only opens on hover or keyboard focus, so
 * on a touch screen the old footer "?" did nothing at all. A popover opens on
 * tap and on click alike. The trigger never takes focus from the search input
 * (`pointerdown` is cancelled and the popover does not auto-focus its content),
 * so the soft keyboard stays up on a phone and typing keeps working on desktop.
 */

import { CircleHelpIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

/** Cheat-sheet lines, in display order (keys under `globalSearch.syntax`). */
export const GLOBAL_SEARCH_SYNTAX_KEYS = [
  "prefixes",
  "in",
  "from",
  "is",
  "after",
  "before",
  "workspace",
  "title",
] as const

export interface GlobalSearchSyntaxHelpProps {
  className?: string
}

export function GlobalSearchSyntaxHelp({ className }: GlobalSearchSyntaxHelpProps) {
  const t = useTranslations("globalSearch")
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t("footer.syntax")}
          // Keep focus (and the soft keyboard) on the search input.
          onPointerDown={(event) => event.preventDefault()}
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground",
            className
          )}
          data-testid="global-search-syntax-help"
        >
          <CircleHelpIcon className="size-4" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        collisionPadding={8}
        onOpenAutoFocus={(event) => event.preventDefault()}
        className="w-auto max-w-[min(20rem,calc(100vw-1rem))] p-3"
        data-testid="global-search-syntax-help-content"
      >
        <p className="mb-1.5 text-xs font-medium">{t("footer.syntax")}</p>
        <ul className="space-y-0.5 text-[11px] text-muted-foreground">
          {GLOBAL_SEARCH_SYNTAX_KEYS.map((key) => (
            <li key={key}>{t(`syntax.${key}`)}</li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
