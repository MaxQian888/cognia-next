"use client"

/**
 * In-app find bar (Ctrl/Cmd+F). A floating input pinned top-right of the
 * content area with a live match count, previous/next navigation (Enter /
 * Shift+Enter), and Esc to close. Open state lives in the UI store (`findOpen`)
 * so the title bar's Edit → Find item can open it too. Mounted once by the
 * desktop shell. Matching + highlighting is delegated to `useFindInPage`.
 */

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useFindInPage } from "@/hooks/desktop/use-find-in-page"
import { useUIStore } from "@/stores/ui/ui-store"

export function FindBar() {
  const t = useTranslations("desktop.find")
  const findOpen = useUIStore((s) => s.findOpen)
  const openFind = useUIStore((s) => s.openFind)
  const closeFind = useUIStore((s) => s.closeFind)
  const { query, setQuery, matchCount, activeIndex, next, prev } = useFindInPage(findOpen)
  const inputRef = useRef<HTMLInputElement>(null)

  // Global Ctrl/Cmd+F opens the bar (suppressing the webview's native find).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F")) {
        e.preventDefault()
        openFind()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [openFind])

  // Focus + select the input each time the bar opens.
  useEffect(() => {
    if (findOpen) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [findOpen])

  if (!findOpen) return null

  const onInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault()
      if (e.shiftKey) prev()
      else next()
    } else if (e.key === "Escape") {
      e.preventDefault()
      closeFind()
    }
  }

  return (
    <div
      data-find-ignore
      data-testid="find-bar"
      role="search"
      className="fixed top-10 right-4 z-50 flex items-center gap-1 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
    >
      <Input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onInputKeyDown}
        placeholder={t("placeholder")}
        aria-label={t("placeholder")}
        data-testid="find-input"
        className="h-7 w-48 text-sm"
      />
      <span
        className="min-w-[3.75rem] px-1 text-center text-xs tabular-nums text-muted-foreground"
        data-testid="find-count"
      >
        {matchCount === 0
          ? t("noMatches")
          : t("matchOf", { index: activeIndex, total: matchCount })}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={prev}
        disabled={matchCount === 0}
        aria-label={t("previous")}
        data-testid="find-prev"
      >
        <ChevronUpIcon className="size-4" aria-hidden />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={next}
        disabled={matchCount === 0}
        aria-label={t("next")}
        data-testid="find-next"
      >
        <ChevronDownIcon className="size-4" aria-hidden />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={closeFind}
        aria-label={t("close")}
        data-testid="find-close"
      >
        <XIcon className="size-4" aria-hidden />
      </Button>
    </div>
  )
}
