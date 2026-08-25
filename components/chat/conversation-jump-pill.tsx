"use client"

/**
 * The one floating control at the foot of the conversation.
 *
 * There are three things it can offer, and they are mutually exclusive in
 * practice, so they share a single pill that morphs rather than stacking up as
 * separate buttons — the chat pane is routinely only ~50% of the window (split
 * view, the Inbox detail pane), where two floating buttons is already clutter.
 *
 *   return       you just jumped somewhere; go back to where you were
 *   newMessages  replies landed while you were reading further up
 *   toBottom     you are simply scrolled up
 *
 * `return` wins when it is on offer: it is the only one that expires, and it
 * answers a question the user asked *deliberately* a moment ago. The other two
 * remain available the whole time you are scrolled up, so nothing is lost by
 * deferring them for a few seconds.
 *
 * Crucially this renders OUTSIDE the scroll container. It used to be an
 * `absolute bottom-4` child of the scroller itself, which makes it part of the
 * scrollable content: it was positioned against the *unscrolled* box and
 * scrolled away with the messages, so past roughly one viewport of scroll —
 * exactly when you need it — it was off-screen. jsdom has no layout, so no unit
 * test could have caught that; there is an e2e spec pinning it instead.
 */

import { AnimatePresence, motion } from "motion/react"
import { ArrowDownIcon, CornerUpLeftIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export type JumpPillMode = "toBottom" | "return" | "newMessages"

export interface ConversationJumpPillProps {
  /** Which offer to show, or null to show nothing. */
  mode: JumpPillMode | null
  /** Replies that landed while scrolled up — only read in `newMessages` mode. */
  newMessageCount?: number
  onReturn: () => void
  onToBottom: () => void
  className?: string
}

/**
 * Decide what the pill should offer. Split out from the component so the
 * precedence rule is testable on its own — it is the part that carries the
 * product decision, and it has no DOM in it.
 */
export function resolveJumpPillMode(input: {
  atBottom: boolean
  canReturn: boolean
  newMessageCount: number
}): JumpPillMode | null {
  // The return offer survives being at the bottom: jumping to the newest turn
  // and then wanting to go back is an ordinary move, and it is the one case
  // where "at the bottom" does not mean "nothing to offer".
  if (input.canReturn) return "return"
  if (input.atBottom) return null
  return input.newMessageCount > 0 ? "newMessages" : "toBottom"
}

export function ConversationJumpPill({
  mode,
  newMessageCount = 0,
  onReturn,
  onToBottom,
  className,
}: ConversationJumpPillProps) {
  const t = useTranslations("chat.jump")
  const { reduce, durationScale } = useFlowMotion()

  const label =
    mode === "return"
      ? t("back")
      : mode === "newMessages"
        ? t("newMessages", { count: newMessageCount })
        : t("toBottom")

  const button = mode ? (
    <Button
      type="button"
      size="sm"
      variant="outline"
      data-testid="conversation-jump-pill"
      data-mode={mode}
      // Icon-only before, so it had no accessible name at all and no string in
      // either locale.
      aria-label={label}
      className={cn(
        "pointer-events-auto h-8 gap-1.5 rounded-pill px-3 text-xs shadow-md",
        "bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80",
        mode === "newMessages" && "border-primary/40 text-primary"
      )}
      onClick={mode === "return" ? onReturn : onToBottom}
    >
      {mode === "return" ? (
        <CornerUpLeftIcon className="size-3.5" aria-hidden />
      ) : (
        <ArrowDownIcon className="size-3.5" aria-hidden />
      )}
      <span>{label}</span>
    </Button>
  ) : null

  // The count is the only part that can change while the pill is already up, so
  // it is the only part that needs announcing.
  const live = (
    <span className="sr-only" aria-live="polite" data-testid="conversation-jump-pill-live">
      {mode === "newMessages" ? label : ""}
    </span>
  )

  if (reduce) {
    return (
      <div className={cn(pillShellClass, className)}>
        {button}
        {live}
      </div>
    )
  }

  return (
    <div className={cn(pillShellClass, className)}>
      <AnimatePresence initial={false} mode="wait">
        {mode ? (
          <motion.div
            // Keyed on the mode so switching offers plays a swap rather than
            // silently relabelling a button the user may be about to click.
            key={mode}
            initial={{ opacity: 0, y: 8, scale: 0.92 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.92 }}
            transition={{
              type: "spring",
              stiffness: 420,
              damping: 32 / durationScale,
              opacity: { duration: 0.14 * durationScale, ease: "easeOut" },
            }}
          >
            {button}
          </motion.div>
        ) : null}
      </AnimatePresence>
      {live}
    </div>
  )
}

/**
 * Pinned to the bottom of the *pane*, and inert to pointers so the strip of
 * message above the composer stays selectable when no offer is showing.
 */
const pillShellClass = "pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center"
