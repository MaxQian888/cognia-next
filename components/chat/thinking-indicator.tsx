"use client"

/**
 * `<ChatThinkingIndicator>` — the "the assistant is working" surface, pinned at
 * the tail of the transcript for the whole streaming turn. One quiet line,
 * driven by `useThinkingPhase`:
 *
 *   from mount  avatar + a shimmering status word that cross-fades every 3s
 *   ≥ 8s        one muted tip line appears beneath it and rotates
 *
 * There is exactly one moving thing at a time — the shimmer sweeping the word.
 * The row used to stack a pulsing avatar, bouncing dots and skeleton bars on
 * top of the shimmer: four motions for one fact, the dots trailing a label
 * that already ends in "…", and grey bars that read as a reply that is not
 * there. Chat products that wait well (ChatGPT, Claude, Cursor) show a single
 * live status and nothing else until text arrives; so does this row now.
 *
 * The label cycles localized `verbs` (Claude Code's playful "Pondering…" touch);
 * the list's first entry is the plain "Claude is thinking…" so the opening frame
 * reads straight. Missing / malformed `verbs` falls back to the `thinking` key.
 *
 * `compact` is for the second half of a turn — once the assistant has produced
 * visible content (text, a tool block, a file) the indicator keeps running below
 * it to show the turn is still alive. The reply above already carries the
 * assistant's identity, so the compact row drops its avatar and lines the label
 * up with the reply's text instead of opening a second, avatar-led "message".
 * Tips still surface, since a tool-heavy stretch is exactly when the wait is
 * long.
 *
 * Named `Chat…` to disambiguate from the generic `ThinkingIndicator` in
 * `components/ui/loading-states.tsx`. All motion routes through
 * `useFlowMotion()`, so the OS preference AND the in-app "reduce motion"
 * setting both turn the shimmer and the word swap into static text (`Shimmer`
 * itself only follows the OS, hence the explicit branch below).
 *
 * ADR-0138 — this row runs for MINUTES on a tool-heavy turn, so nothing here may
 * move the transcript. The status word changes width as it rotates, and that is
 * now harmless: nothing sits to its right any more (the dots it used to shunt
 * are gone), and the outgoing and incoming words share one grid cell, so the
 * row's height never changes. The tip line is a fixed single line (truncated)
 * for the same reason.
 */

import { useTranslations } from "next-intl"
import { AnimatePresence, motion } from "motion/react"
import { SparklesIcon } from "lucide-react"

import { Shimmer } from "@/components/ai-elements/shimmer"
import { ReadingCollapse, useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { ThinkingTips } from "@/components/chat/thinking-tips"
import { useThinkingPhase } from "@/hooks/chat/use-thinking-phase"
import { avatarColor, avatarGlyph } from "@/lib/ui/avatar"
import type { Character } from "@cognia/agent-config-types"
import { cn } from "@/lib/utils"

export interface ChatThinkingIndicatorProps {
  /** Session-bound character (1:1 chat) — tints the avatar when set. */
  directCharacter?: Character | null
  /** Assistant content is already on screen — no avatar, label aligned with the reply. */
  compact?: boolean
  className?: string
}

export function ChatThinkingIndicator({
  directCharacter,
  compact = false,
  className,
}: ChatThinkingIndicatorProps) {
  const t = useTranslations("chat.list")
  const { reduce, durationScale } = useFlowMotion()

  const tips = readStringList(t, "tips")
  const verbs = readStringList(t, "verbs")
  const { showTips, tipIndex, verbIndex } = useThinkingPhase({
    tipCount: tips.length,
    verbCount: verbs.length,
    reduce,
  })
  const label =
    verbs.length > 0 ? (verbs[verbIndex % verbs.length] ?? t("thinking")) : t("thinking")

  const tinted = directCharacter ? avatarColor(directCharacter) : undefined

  return (
    <div
      className={cn("flex flex-col gap-1 px-1 py-2", className)}
      data-testid="chat-thinking-indicator"
      data-compact={compact ? "true" : undefined}
    >
      <div className={cn("flex items-center gap-2", compact && "pl-8")}>
        {compact ? null : (
          <span
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-medium",
              !tinted && "bg-primary/10 text-primary"
            )}
            style={tinted ? { backgroundColor: tinted, color: "white" } : undefined}
            aria-hidden
            data-testid="thinking-avatar"
          >
            {directCharacter ? avatarGlyph(directCharacter) : <SparklesIcon className="size-3.5" />}
          </span>
        )}
        <span className="grid">
          {reduce ? (
            <span className="whitespace-nowrap text-sm text-muted-foreground">{label}</span>
          ) : (
            // No `mode="wait"`: both words overlap in one grid cell while they
            // cross-fade, so the row is never empty and never changes height.
            <AnimatePresence initial={false}>
              <motion.span
                key={label}
                className="col-start-1 row-start-1"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.25 * durationScale, ease: "easeOut" }}
              >
                <Shimmer as="span" className="whitespace-nowrap text-sm">
                  {label}
                </Shimmer>
              </motion.span>
            </AnimatePresence>
          )}
        </span>
      </div>

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
