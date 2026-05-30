"use client"

import { memo, useCallback, useState } from "react"
import type { UIMessage } from "ai"
import type { Virtualizer } from "@tanstack/react-virtual"
import { useTranslations } from "next-intl"
import { ChevronRightIcon, ListTreeIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useSettingsStore } from "@/stores/settings"
import { useTimelineTurns, type TimelineTurn } from "./use-timeline-turns"
import { useTimelineScrollSync } from "./use-timeline-scroll-sync"

interface Props {
  messages: UIMessage[]
  scrollRef: React.RefObject<HTMLDivElement | null>
  virtualizer: Virtualizer<HTMLDivElement, Element>
  virtualize: boolean
}

function formatTime(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms)) return ""
  try {
    return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
  } catch {
    return ""
  }
}

/**
 * Right-edge, timeline-style conversation minimap. Collapsed it's a thin rail
 * with proportional turn markers and a viewport slider; expanded it's a
 * vertical timeline of user turns with hover previews and click-to-jump.
 * Desktop / wide-screen only (`lg`); mounting + threshold gating live in the
 * parent. Memoised + self-contained scroll sync so it doesn't re-render the
 * message list.
 */
export const ConversationTimeline = memo(function ConversationTimeline({
  messages,
  scrollRef,
  virtualizer,
  virtualize,
}: Props) {
  const t = useTranslations("chat.timeline")
  const turns = useTimelineTurns(messages)
  const geom = useTimelineScrollSync({ scrollRef, virtualizer, virtualize, turns })

  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const pinned = settings?.conversationTimeline?.expanded ?? false
  const [hovered, setHovered] = useState(false)
  const expanded = pinned || hovered

  const setPinned = useCallback(
    (next: boolean) => {
      void save({
        conversationTimeline: { ...(settings?.conversationTimeline ?? {}), expanded: next },
      })
    },
    [save, settings?.conversationTimeline]
  )

  const jumpTo = useCallback(
    (turn: TimelineTurn) => {
      if (virtualize && virtualizer) {
        virtualizer.scrollToIndex(turn.index, { align: "start" })
        return
      }
      const sel = `[data-msg-id="${turn.id.replace(/["\\]/g, "\\$&")}"]`
      scrollRef.current?.querySelector<HTMLElement>(sel)?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      })
    },
    [virtualize, virtualizer, scrollRef]
  )

  if (turns.length === 0) return null

  return (
    <div
      className="absolute right-0 top-0 bottom-0 z-20 hidden lg:flex"
      onMouseLeave={() => setHovered(false)}
      data-testid="conversation-timeline"
    >
      {expanded ? (
        <div className="flex h-full w-64 flex-col border-l bg-background/95 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <ListTreeIcon className="size-3.5" />
              {t("title")}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label={t("collapse")}
              onClick={() => {
                setHovered(false)
                setPinned(false)
              }}
            >
              <ChevronRightIcon className="size-4" />
            </Button>
          </div>
          <div className="relative flex-1 overflow-y-auto py-1">
            {/* connector line */}
            <div
              aria-hidden
              className="pointer-events-none absolute bottom-2 left-[14px] top-2 w-px bg-border"
            />
            <ul className="flex flex-col">
              {turns.map((turn, i) => {
                const active = i === geom.activeIndex
                const time = formatTime(turn.time)
                return (
                  <li key={turn.id}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => jumpTo(turn)}
                          aria-current={active ? "true" : undefined}
                          aria-label={t("jumpTo", { label: turn.label })}
                          className={cn(
                            "relative flex w-full items-start gap-2 py-1.5 pl-2.5 pr-2 text-left transition-colors hover:bg-accent",
                            active && "bg-accent/60"
                          )}
                        >
                          <span
                            aria-hidden
                            className={cn(
                              "z-10 mt-1 size-2 shrink-0 rounded-full border-2 border-background",
                              active ? "bg-primary" : "bg-muted-foreground/50"
                            )}
                          />
                          <span className="min-w-0 flex-1">
                            <span
                              className={cn(
                                "block truncate text-xs",
                                active ? "font-medium text-foreground" : "text-muted-foreground"
                              )}
                            >
                              {turn.label}
                            </span>
                            <span className="mt-0.5 block text-[10px] text-muted-foreground/70">
                              {time && <span>{time}</span>}
                              {time && turn.replyCount > 0 && <span> · </span>}
                              {turn.replyCount > 0 && (
                                <span>{t("replyCount", { count: turn.replyCount })}</span>
                              )}
                            </span>
                          </span>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="left" className="max-w-xs">
                        {turn.preview}
                      </TooltipContent>
                    </Tooltip>
                  </li>
                )
              })}
            </ul>
          </div>
        </div>
      ) : (
        <button
          type="button"
          aria-label={t("expand")}
          onClick={() => setPinned(true)}
          onMouseEnter={() => setHovered(true)}
          onFocus={() => setHovered(true)}
          className="group relative h-full w-3 cursor-pointer bg-transparent transition-colors hover:bg-accent/30"
        >
          {/* viewport slider */}
          <span
            aria-hidden
            className="absolute inset-x-0.5 rounded-full bg-primary/15 group-hover:bg-primary/25"
            style={{
              top: `${geom.viewportTop * 100}%`,
              height: `${Math.max(geom.viewportHeight * 100, 4)}%`,
            }}
          />
          {turns.map((turn, i) => (
            <span
              key={turn.id}
              aria-hidden
              className={cn(
                "absolute right-1 size-1.5 -translate-y-1/2 rounded-full",
                i === geom.activeIndex ? "bg-primary" : "bg-muted-foreground/40"
              )}
              style={{ top: `${(geom.positions[i] ?? 0) * 100}%` }}
            />
          ))}
        </button>
      )}
    </div>
  )
})
