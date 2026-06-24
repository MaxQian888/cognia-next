"use client"

/**
 * `<ChatThinkingIndicator>` — the "waiting for the assistant's first token"
 * surface. Replaces the bare `Claude is thinking…` shimmer with a phased
 * affordance driven by `useThinkingPhase`:
 *
 *   phase 1  avatar pulse + shimmer label + bouncing dots
 *   phase 2  (≥3s) skeleton placeholder lines collapse-reveal beneath it
 *   phase 3  (≥4s) a rotating built-in tip appears
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
import type { Character } from "@/lib/claude/types"
import { cn } from "@/lib/utils"

export interface ChatThinkingIndicatorProps {
  /** Session-bound character (1:1 chat) — tints the pulsing avatar when set. */
  directCharacter?: Character | null
  /** Called when the row's height grows, so the list can re-pin scroll. */
  onPhaseChange?: () => void
  className?: string
}

export function ChatThinkingIndicator({
  directCharacter,
  onPhaseChange,
  className,
}: ChatThinkingIndicatorProps) {
  const t = useTranslations("chat.list")
  const { reduce } = useFlowMotion()

  const tips = readTips(t)
  const { showSkeleton, showTips, tipIndex } = useThinkingPhase({
    tipCount: tips.length,
    reduce,
  })

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
          {t("thinking")}
        </Shimmer>
        <LoadingDots className={cn("ml-0.5", reduce && "opacity-70 [&_*]:animate-none")} />
      </div>

      <MotionCollapse open={showSkeleton}>
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

/** Read the curated tip list; tolerate a missing / malformed `tips` key. */
function readTips(t: ReturnType<typeof useTranslations>): string[] {
  try {
    const raw = t.raw("tips") as unknown
    if (!Array.isArray(raw)) return []
    return raw.filter((x): x is string => typeof x === "string")
  } catch {
    return []
  }
}
