"use client"

/**
 * The title bar's command-palette pill: app name + active conversation, a
 * streaming dot while a turn is in flight, and the ⌘K hint.
 *
 * It used to be a private component inside `title-bar.tsx`. It moved out when
 * the bar became customizable — `title-bar-zone.tsx` mounts segments by id, so
 * every segment has to be importable.
 *
 * The chat-store status (which changes per token during streaming) and the
 * `useActiveSessionLabel` live query stay scoped to this leaf rather than
 * sitting on `TitleBar`: on the bar itself they forced the whole menubar tree
 * to re-render whenever the active chat changed.
 */

import { SearchIcon } from "lucide-react"

import { useActiveSessionLabel } from "@/hooks/chat/use-active-session-label"
import { cn } from "@/lib/utils"
import { useChatStore } from "@/stores/chat/chat-store"

export function TitleBarSearchPill({
  appName,
  separator,
  placeholder,
  kbdHint,
  onClick,
  className,
}: {
  appName: string
  separator: string
  placeholder: string
  kbdHint: string
  onClick: () => void
  className?: string
}) {
  const status = useChatStore((s) => s.status)
  const { label: doc } = useActiveSessionLabel()
  const title = doc ? `${appName}${separator}${doc}` : appName
  const isStreaming = status === "streaming"

  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="title-bar-search-pill"
      aria-label={placeholder}
      className={cn(
        "group flex h-6 min-w-[180px] max-w-[480px] flex-1 items-center gap-2",
        "rounded-md border border-border bg-background/60 px-2 text-xs",
        "text-muted-foreground transition-colors hover:bg-background hover:text-foreground",
        className
      )}
    >
      {isStreaming ? (
        <span
          aria-hidden
          data-testid="title-bar-streaming-dot"
          className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary"
        />
      ) : (
        <SearchIcon aria-hidden className="size-3 shrink-0" />
      )}
      <span className="truncate font-medium tracking-tight" data-testid="title-bar-title">
        {title}
      </span>
      <span aria-hidden className="ml-auto hidden text-[10px] opacity-60 sm:inline">
        {kbdHint}
      </span>
    </button>
  )
}
