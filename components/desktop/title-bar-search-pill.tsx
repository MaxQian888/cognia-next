"use client"

/**
 * The title bar's command-palette pill: app name + active conversation, a
 * streaming dot while a turn is in flight, and the ⌘K hint.
 *
 * One shape on every route. It briefly had a narrow icon+shortcut variant for
 * the case where a projected chat header carried the conversation title beside
 * it, but that made the top bar redraw itself whenever the chat column came and
 * went — the shell reading as flickering rather than tidy. The bar's own
 * segments are constant now; only the outlets' contents vary.
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

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { SearchIcon } from "lucide-react"

import { useActiveSessionLabel } from "@/hooks/chat/use-active-session-label"
import { aggregateRunState } from "@/lib/chat/aggregate-run-state"
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
  // The other strings arrive as props so the bar can keep this leaf render
  // stable; this one is local because only the leaf knows the count.
  const t = useTranslations("desktop.statusBar")
  const sessions = useChatStore((s) => s.sessions)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const run = useMemo(
    () => aggregateRunState({ sessions, activeSessionId }),
    [sessions, activeSessionId]
  )
  const { label: doc } = useActiveSessionLabel()
  const title = doc ? `${appName}${separator}${doc}` : appName
  // The dot belongs to the conversation this pill NAMES, so it stays focused.
  // What was missing is the other half: with the named conversation idle and
  // two more streaming, the pill was the shell's most prominent "nothing is
  // happening" claim. The count says otherwise without stealing the dot.
  const isStreaming = run.focused === "streaming"
  const backgroundHint = t("runningCount", { count: run.active })

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
      {run.activeElsewhere ? (
        <span
          data-testid="title-bar-background-count"
          title={backgroundHint}
          aria-label={backgroundHint}
          className="ml-auto shrink-0 rounded-sm bg-primary/15 px-1 text-[10px] font-medium tabular-nums text-primary"
        >
          {run.active}
        </span>
      ) : null}
      <span
        aria-hidden
        className={cn("hidden text-[10px] opacity-60 sm:inline", !run.activeElsewhere && "ml-auto")}
      >
        {kbdHint}
      </span>
    </button>
  )
}
