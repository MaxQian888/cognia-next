"use client"

/**
 * `<ChatThinkingIndicator>` — the "the assistant is working" surface, pinned at
 * the tail of the transcript for the whole streaming turn. A phased affordance
 * driven by `useThinkingPhase`:
 *
 *   phase 1  avatar pulse + shimmer label + bouncing dots
 *   phase 2  (≥3s) skeleton placeholder lines collapse-reveal beneath it
 *   phase 3  (≥4s) a rotating built-in tip appears
 *
 * The label cycles localized `verbs` (Claude Code's playful "Pondering…" touch);
 * the list's first entry is the plain "Claude is thinking…" so the opening frame
 * reads straight. Missing / malformed `verbs` falls back to the `thinking` key.
 *
 * `compact` is for the second half of a turn — once the assistant has produced
 * visible content (text, a tool block, a file) the indicator keeps running below
 * it to show the turn is still alive, but drops the skeleton: placeholder lines
 * under real content read as a second, phantom reply. Tips still surface, since
 * a tool-heavy stretch is exactly when the wait is long.
 *
 * Named `Chat…` to disambiguate from the generic `ThinkingIndicator` in
 * `components/ui/loading-states.tsx`. All motion routes through
 * `useFlowMotion()` so the OS / appearance "reduce motion" preference collapses
 * the pulse, the collapse-reveal, and the tip crossfade to static output.
 *
 * `onPhaseChange` fires whenever the visible height grows (skeleton/tips reveal
 * or tip rotation) so the message list can re-pin the scroll to the bottom —
 * the stick-to-bottom effect there only watches `messages`/`status` and is
 * otherwise blind to this row's internal timers.
 */

import { useEffect } from "react"
import { useTranslations } from "next-intl"
import { SparklesIcon } from "lucide-react"

import { Shimmer } from "@/components/ai-elements/shimmer"
import { LoadingDots } from "@/components/ui/loading-states"
import { Skeleton } from "@/components/ui/skeleton"
import { MotionCollapse, useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { ThinkingTips } from "@/components/chat/thinking-tips"
import { useThinkingPhase } from "@/hooks/chat/use-thinking-phase"
import { avatarColor, avatarGlyph } from "@/lib/ui/avatar"
import type { Character } from "@cognia/agent-config-types"
import { cn } from "@/lib/utils"

export interface ChatThinkingIndicatorProps {
  /** Session-bound character (1:1 chat) — tints the pulsing avatar when set. */
  directCharacter?: Character | null
  /** Called when the row's height grows, so the list can re-pin scroll. */
  onPhaseChange?: () => void
  /** Assistant content is already on screen — drop the skeleton placeholder. */
  compact?: boolean
  className?: string
}

export function ChatThinkingIndicator({
  directCharacter,
  onPhaseChange,
  compact = false,
  className,
}: ChatThinkingIndicatorProps) {
  const t = useTranslations("chat.list")
  const { reduce } = useFlowMotion()

  const tips = readStringList(t, "tips")
  const verbs = readStringList(t, "verbs")
  const { showSkeleton, showTips, tipIndex, verbIndex } = useThinkingPhase({
    tipCount: tips.length,
    verbCount: verbs.length,
    reduce,
  })
  const label =
    verbs.length > 0 ? (verbs[verbIndex % verbs.length] ?? t("thinking")) : t("thinking")

  // Re-pin scroll whenever the indicator grows or the tip rotates. This is a
  // plain callback (not setState), so it's clear of the set-state-in-effect rule.
  useEffect(() => {
    onPhaseChange?.()
  }, [showSkeleton, showTips, tipIndex, onPhaseChange])

  const tinted = directCharacter ? avatarColor(directCharacter) : undefined

  return (
    <div
      className={cn("flex flex-col gap-1.5 px-1 py-2", className)}
      data-testid="chat-thinking-indicator"
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-medium",
            !tinted && "bg-primary/10 text-primary",
            !reduce && "animate-pulse"
          )}
          style={tinted ? { backgroundColor: tinted, color: "white" } : undefined}
          aria-hidden
        >
          {directCharacter ? avatarGlyph(directCharacter) : <SparklesIcon className="size-3.5" />}
        </span>
        <Shimmer as="span" className="text-sm">
          {label}
        </Shimmer>
        <LoadingDots className={cn("ml-0.5", reduce && "opacity-70 [&_*]:animate-none")} />
      </div>

      <MotionCollapse open={showSkeleton && !compact}>
        <div className="space-y-2 pl-8 pt-1" data-testid="thinking-skeleton" aria-hidden>
          <Skeleton className="h-3.5 w-3/4" />
          <Skeleton className="h-3.5 w-5/6" />
          <Skeleton className="h-3.5 w-1/2" />
        </div>
      </MotionCollapse>

      <MotionCollapse open={showTips && tips.length > 0}>
        <ThinkingTips tips={tips} index={tipIndex} className="pl-8" />
      </MotionCollapse>
    </div>
  )
}

/** Read a curated string list; tolerate a missing / malformed key. */
function readStringList(t: ReturnType<typeof useTranslations>, key: string): string[] {
  try {
    const raw = t.raw(key) as unknown
    if (!Array.isArray(raw)) return []
    return raw.filter((x): x is string => typeof x === "string")
  } catch {
    return []
  }
}
