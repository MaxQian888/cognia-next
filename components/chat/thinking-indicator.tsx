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
 * ADR-0138 — this row runs for MINUTES on a tool-heavy turn, so anything here
 * that moves is a permanent tremor at the foot of the reading column, right
 * under the reply. Two things did:
 *
 *   - the label rotates a verb every 3s, and a plain `<span>` changes width
 *     with it, which shunted the bouncing dots sideways on every rotation. The
 *     label now sits in a grid cell sized by every verb stacked invisibly
 *     behind it, so the cell is as wide as the longest verb from frame one and
 *     the swap is pure opacity;
 *   - the tip rotates every 5s, and tips of different lengths wrap to one line
 *     or two. The tip box is a fixed two lines tall (clamped), so a rotation
 *     can no longer change the row's height.
 *
 * It also used to call back on every phase/tip change so the list could force a
 * scroll pin. That is gone: `useStickToBottom` watches the content box, so the
 * one growth that IS real — the skeleton and tip revealing — is followed
 * without this row knowing anything about scrolling.
 */

import { useTranslations } from "next-intl"
import { SparklesIcon } from "lucide-react"

import { Shimmer } from "@/components/ai-elements/shimmer"
import { LoadingDots } from "@/components/ui/loading-states"
import { Skeleton } from "@/components/ui/skeleton"
import { ReadingCollapse, useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { ThinkingTips } from "@/components/chat/thinking-tips"
import { useThinkingPhase } from "@/hooks/chat/use-thinking-phase"
import { avatarColor, avatarGlyph } from "@/lib/ui/avatar"
import type { Character } from "@cognia/agent-config-types"
import { cn } from "@/lib/utils"

export interface ChatThinkingIndicatorProps {
  /** Session-bound character (1:1 chat) — tints the pulsing avatar when set. */
  directCharacter?: Character | null
  /** Assistant content is already on screen — drop the skeleton placeholder. */
  compact?: boolean
  className?: string
}

export function ChatThinkingIndicator({
  directCharacter,
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
        {/* One grid cell holding every verb: the invisible copies size it to
            the longest one, so rotating the label cannot move the dots. */}
        <span className="grid">
          {verbs.map((verb) => (
            <span
              key={verb}
              aria-hidden
              className="invisible col-start-1 row-start-1 whitespace-nowrap text-sm"
            >
              {verb}
            </span>
          ))}
          <Shimmer as="span" className="col-start-1 row-start-1 whitespace-nowrap text-sm">
            {label}
          </Shimmer>
        </span>
        <LoadingDots className={cn("ml-0.5", reduce && "opacity-70 [&_*]:animate-none")} />
      </div>

      <ReadingCollapse open={showSkeleton && !compact}>
        <div className="space-y-2 pl-8 pt-1" data-testid="thinking-skeleton" aria-hidden>
          <Skeleton className="h-3.5 w-3/4" />
          <Skeleton className="h-3.5 w-5/6" />
          <Skeleton className="h-3.5 w-1/2" />
        </div>
      </ReadingCollapse>

      <ReadingCollapse open={showTips && tips.length > 0}>
        <ThinkingTips tips={tips} index={tipIndex} className="pl-8" />
      </ReadingCollapse>
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
