"use client"

/**
 * `<StreamingTextPart>` — narrow subtree owning Streamdown's `MessageResponse`
 * for the actively-streaming text branch of `MessageRenderer`. Extracted so:
 *
 *   1. `useDeferredValue(text)` lives at a tight boundary — React can yield
 *      to higher-priority work (scroll, keyboard input) when the markdown
 *      commit gets long, at the cost of at most one frame of token lag.
 *   2. The outer `MessageRenderer` body (header, mentions, avatar, plugin
 *      slots, action bar) stays out of the per-token render path conceptually.
 *      The memo equality on (text, isStreaming) is a no-op when text changes
 *      per token, but pairs with Stage 4's heavy-block lazy-load + Stage 6's
 *      `<Activity>` to keep the streaming subtree minimal.
 *
 * Pairs with the non-streaming text branch in `MessageRenderer`, which
 * routes through `<MarkdownRenderer>` for the finalised message.
 */

import { memo, useDeferredValue } from "react"
import { MessageResponse } from "@/components/ai-elements/message"
import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { cn } from "@/lib/utils"

interface Props {
  text: string
  isStreaming: boolean
}

function StreamingTextPartInner({ text }: Props) {
  // Deferred so React can interrupt the markdown commit when a faster event
  // (scroll, focus, key) arrives. Token visibility lags by ≤1 frame.
  const deferred = useDeferredValue(text)
  // Reduced motion: a static (non-blinking) caret so we still signal "more is
  // coming" without an animation. `animate-pulse` is a guaranteed Tailwind
  // utility (no dependency on `animate-caret-blink`).
  const { reduce } = useFlowMotion()
  return (
    <>
      <MessageResponse>{deferred}</MessageResponse>
      <span
        aria-hidden
        data-testid="streaming-caret"
        className={cn(
          "ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 rounded-full bg-foreground/60 align-middle",
          !reduce && "animate-pulse"
        )}
      />
    </>
  )
}

export const StreamingTextPart = memo(
  StreamingTextPartInner,
  (prev, next) => prev.text === next.text && prev.isStreaming === next.isStreaming
)
StreamingTextPart.displayName = "StreamingTextPart"
