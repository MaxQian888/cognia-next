"use client"

/**
 * The mobile conversation list's search box.
 *
 * Its own component so a keystroke re-renders the field and nothing else: the
 * text lives in the list source's field context, and only the debounced value
 * reaches the list (`mobile-channel-list-source.tsx`).
 *
 * `type="search"` is load-bearing on phones. The coarse-pointer 16px floor in
 * `app/globals.css` matches inputs by `type`, and a typeless shadcn `<Input>`
 * slipped past it at 14px — which is what made iOS zoom the whole page every
 * time the field took focus. The browser's own cancel glyph is hidden because
 * the clear button below replaces it at a thumb-sized target.
 */

import { useTranslations } from "next-intl"
import { SearchIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

import { useMobileChannelSearchField } from "./mobile-channel-list-source"

export function MobileChannelSearchField({ className }: { className?: string }) {
  const t = useTranslations("mobile.home")
  const tShell = useTranslations("mobile.shell")
  const { value, onChange, onClear } = useMobileChannelSearchField()
  const hasValue = value.length > 0
  return (
    <div className={cn("relative min-w-0 flex-1", className)}>
      <SearchIcon
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        type="search"
        inputMode="search"
        enterKeyHint="search"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Escape empties the box first; a second Escape reaches the drawer.
          if (e.key === "Escape" && hasValue) {
            e.preventDefault()
            e.stopPropagation()
            onClear()
          }
        }}
        placeholder={t("search")}
        aria-label={t("searchAria")}
        data-testid="mobile-channel-search"
        className={cn(
          "h-11 w-full min-w-0 pl-9 [&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none",
          // Reserve the clear button's width only while it is on screen.
          hasValue ? "pr-11" : "pr-3"
        )}
      />
      {hasValue ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={tShell("clearSearch")}
          data-testid="mobile-channel-search-clear"
          onClick={onClear}
          className="absolute top-0 right-0 size-11 rounded-md text-muted-foreground"
        >
          <XIcon className="size-4" />
        </Button>
      ) : null}
    </div>
  )
}
