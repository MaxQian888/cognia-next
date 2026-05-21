"use client"

/**
 * Debounced search input for the conversation list.
 *
 * Keeps internal state for the raw text and emits the debounced value
 * through `onDebouncedChange` so the parent's live-query filter only
 * re-runs at most every `debounceMs` (default 200ms). Esc clears the
 * input; the explicit clear button is keyboard-accessible.
 */

import { useEffect, useId, useState } from "react"
// React 19: mirror an external prop into local state via the documented
// "store prev value, compare during render" pattern so we don't trip
// `react-hooks/set-state-in-effect`.
import { useTranslations } from "next-intl"
import { SearchIcon, XIcon } from "lucide-react"
import { cn } from "@/lib/utils"

export interface ConversationSearchInputProps {
  /** Current debounced value — controlled externally so the parent can
   * also reset it (e.g. after route changes). */
  value: string
  onDebouncedChange: (next: string) => void
  /** Tailwind className applied to the outer wrapper. */
  className?: string
  /** Override debounce window for tests. */
  debounceMs?: number
}

export function ConversationSearchInput({
  value,
  onDebouncedChange,
  className,
  debounceMs = 200,
}: ConversationSearchInputProps) {
  const t = useTranslations("inbox.conversationList.search")
  const [text, setText] = useState(value)
  const [trackedValue, setTrackedValue] = useState(value)
  const inputId = useId()

  // Sync external resets back into internal text — the parent owning the
  // debounced value can blank it (e.g. on route change) and we should
  // mirror that immediately, not wait for a debounce cycle.
  if (trackedValue !== value) {
    setTrackedValue(value)
    setText(value)
  }

  // Debounce internal text → external commit so the live-query re-fires
  // at most every `debounceMs` ms. Cleared on unmount.
  useEffect(() => {
    if (text === value) return
    const id = setTimeout(() => onDebouncedChange(text), debounceMs)
    return () => clearTimeout(id)
  }, [text, value, debounceMs, onDebouncedChange])

  const clear = () => {
    setText("")
    onDebouncedChange("")
  }

  return (
    <div className={cn("relative", className)}>
      <SearchIcon
        className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <input
        id={inputId}
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && text) {
            e.preventDefault()
            clear()
          }
        }}
        placeholder={t("placeholder")}
        aria-label={t("aria")}
        data-testid="conversation-search-input"
        className={cn(
          "h-8 w-full rounded-md border bg-background pl-7 pr-7 text-xs",
          "placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring",
          "[&::-webkit-search-cancel-button]:hidden"
        )}
      />
      {text.length > 0 && (
        <button
          type="button"
          onClick={clear}
          aria-label={t("clear")}
          data-testid="conversation-search-clear"
          className="absolute right-1.5 top-1/2 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted"
        >
          <XIcon className="size-3" aria-hidden />
        </button>
      )}
    </div>
  )
}
