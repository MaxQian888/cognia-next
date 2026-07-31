"use client"

import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react"

import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

export type FindResult = { matches: number; index: number }

/**
 * True for the Cmd/Ctrl+F find shortcut (never with Alt). Shared by both preview
 * panes so the match rule cannot drift between them; the surrounding behaviour
 * (URL guard, native key forwarding) stays each pane's own.
 */
export function isFindShortcut(event: {
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  key: string
}): boolean {
  return (
    (event.metaKey || event.ctrlKey) && !event.altKey && (event.key === "f" || event.key === "F")
  )
}

/**
 * Find-in-page bar: query input + `n/m` counter + prev/next + close. Owns its
 * own query state and delegates the actual search to `onSearch` (which drives
 * the injected `__cogniaFind` helper on whichever preview path is live). Enter =
 * next match, Shift+Enter = previous, Escape = close.
 */
export function BrowserFindBar({
  onSearch,
  onClose,
  className,
}: {
  onSearch: (query: string, options: { forward: boolean }) => Promise<FindResult> | FindResult
  onClose: () => void
  className?: string
}) {
  const t = useTranslations("browser.find")
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState("")
  const [result, setResult] = useState<FindResult>({ matches: 0, index: 0 })

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const run = useCallback(
    async (q: string, forward: boolean) => {
      try {
        setResult(await onSearch(q, { forward }))
      } catch {
        // A webview / RPC eval can reject (preview torn down, injected helper
        // missing). Degrade to "no matches" instead of leaving an unhandled
        // rejection and a stale counter.
        setResult({ matches: 0, index: 0 })
      }
    },
    [onSearch]
  )

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault()
        void run(query, !e.shiftKey)
      } else if (e.key === "Escape") {
        e.preventDefault()
        onClose()
      }
    },
    [query, run, onClose]
  )

  const noMatches = result.matches === 0
  const counter = query
    ? noMatches
      ? t("noMatches")
      : t("count", { current: result.index + 1, total: result.matches })
    : ""

  return (
    <div
      data-testid="browser-find-bar"
      className={cn(
        "flex max-w-full items-center gap-1 rounded-md border bg-background/95 p-1 shadow-md",
        className
      )}
    >
      <Input
        ref={inputRef}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          void run(e.target.value, true)
        }}
        onKeyDown={onKeyDown}
        placeholder={t("placeholder")}
        aria-label={t("placeholder")}
        className="h-7 w-40 min-w-16 border-transparent bg-transparent text-sm shadow-none focus-visible:ring-0"
      />
      <span className="min-w-12 shrink-0 px-1 text-center text-xs tabular-nums text-muted-foreground">
        {counter}
      </span>
      <TooltipIconButton
        tooltip={t("previous")}
        aria-label={t("previous")}
        size="icon-xs"
        disabled={noMatches}
        onClick={() => void run(query, false)}
      >
        <ChevronUpIcon />
      </TooltipIconButton>
      <TooltipIconButton
        tooltip={t("next")}
        aria-label={t("next")}
        size="icon-xs"
        disabled={noMatches}
        onClick={() => void run(query, true)}
      >
        <ChevronDownIcon />
      </TooltipIconButton>
      <TooltipIconButton
        tooltip={t("close")}
        aria-label={t("close")}
        size="icon-xs"
        onClick={onClose}
      >
        <XIcon />
      </TooltipIconButton>
    </div>
  )
}

/** The find bar in its standard right-aligned, bordered row — shared by both preview panes. */
export function BrowserFindBarSection({
  onSearch,
  onClose,
}: {
  onSearch: (query: string, options: { forward: boolean }) => Promise<FindResult> | FindResult
  onClose: () => void
}) {
  return (
    <div className="flex justify-end border-b bg-background px-2 py-1">
      <BrowserFindBar onSearch={onSearch} onClose={onClose} />
    </div>
  )
}
