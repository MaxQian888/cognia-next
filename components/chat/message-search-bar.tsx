"use client"

// Find-in-conversation bar for the message list. Owns the query + hit cursor
// and reports upward: `onJump` scrolls the list, `onActiveHitChange` tells it
// which row to highlight. Kept out of MessageList so typing here re-renders the
// bar, not the conversation.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { UIMessage } from "ai"
import { useTranslations } from "next-intl"
import { ChevronDownIcon, ChevronUpIcon, SearchIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { findMessageHits, stepHitIndex, type MessageSearchHit } from "@/lib/chat/message-search"

interface Props {
  messages: UIMessage[]
  /** Scroll the list to a hit. */
  onJump: (hit: MessageSearchHit) => void
  /** The message id to highlight, or null when there's no active hit. */
  onActiveHitChange: (id: string | null) => void
  onClose: () => void
}

export const MessageSearchBar = memo(function MessageSearchBar({
  messages,
  onJump,
  onActiveHitChange,
  onClose,
}: Props) {
  const t = useTranslations("chat.search")
  const [query, setQuery] = useState("")
  const [cursor, setCursor] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)

  const hits = useMemo(() => findMessageHits(messages, query), [messages, query])

  // Opening the bar should put the caret in it — otherwise the shortcut that
  // opened it would need a second click to be useful.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Held in a ref so the live-find effect below can call the *current* onJump
  // without taking it as a dependency. The caller's callback closes over the
  // virtualizer, whose identity churns on every list re-render — and the list
  // re-renders whenever we report a new highlight. Depending on it directly
  // makes navigating a hit re-trigger "land on the first hit", pinning the
  // cursor at 1 forever.
  const onJumpRef = useRef(onJump)
  useEffect(() => {
    onJumpRef.current = onJump
  })

  // Live find: a new hit set lands on its own first hit, so the readout and the
  // viewport agree before the user presses anything and Enter can mean plain
  // "next".
  useEffect(() => {
    if (hits.length === 0) {
      setCursor(-1)
      return
    }
    setCursor(0)
    onJumpRef.current(hits[0])
  }, [hits])

  const active = cursor >= 0 ? hits[cursor] : undefined

  // Report the highlight target as a plain effect rather than inside the
  // setState callers, so it stays correct however the cursor moved.
  useEffect(() => {
    onActiveHitChange(active?.id ?? null)
  }, [active?.id, onActiveHitChange])

  // Clear the highlight when the bar goes away, so a stale ring can't outlive it.
  useEffect(() => () => onActiveHitChange(null), [onActiveHitChange])

  const go = useCallback(
    (delta: number) => {
      if (hits.length === 0) return
      const next = stepHitIndex(cursor, delta, hits.length)
      setCursor(next)
      const hit = hits[next]
      if (hit) onJumpRef.current(hit)
    },
    [hits, cursor]
  )

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape") {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== "Enter") return
      event.preventDefault()
      go(event.shiftKey ? -1 : 1)
    },
    [onClose, go]
  )

  return (
    <div
      className="flex items-center gap-1.5 border-b bg-background/95 px-3 py-1.5"
      data-testid="message-search-bar"
    >
      <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <Input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={t("placeholder")}
        aria-label={t("label")}
        className="h-7 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
      />
      <span
        className="shrink-0 text-xs tabular-nums text-muted-foreground"
        data-testid="message-search-count"
        aria-live="polite"
      >
        {query.trim() === ""
          ? ""
          : hits.length === 0
            ? t("noResults")
            : t("position", { current: cursor + 1, total: hits.length })}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="size-6 shrink-0"
        aria-label={t("previous")}
        disabled={hits.length === 0}
        onClick={() => go(-1)}
      >
        <ChevronUpIcon className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-6 shrink-0"
        aria-label={t("next")}
        disabled={hits.length === 0}
        onClick={() => go(1)}
      >
        <ChevronDownIcon className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-6 shrink-0"
        aria-label={t("close")}
        onClick={onClose}
      >
        <XIcon className="size-3.5" />
      </Button>
    </div>
  )
})
