"use client"

// Typewriter placeholder hints — a fourth overlay layer in the composer box,
// painted under the textarea's caret exactly where the native placeholder
// would sit. The hero (welcome) composer uses it to type out example prompts
// char by char; docked composers keep the static placeholder.
//
// Focus/caret contract: `pointer-events-none` + `aria-hidden`, no focusable
// children, and the layer is mounted ONLY while the input is empty — so the
// first keystroke hides it instantly and no exit animation can lag behind
// typed text. The typing state machine lives entirely inside this leaf
// component: a per-phase `setTimeout` re-renders nothing outside itself.
//
// The hint paints no caret of its own — the textarea's real caret stays
// visible at position 0, so a click into the box visibly takes focus. A fake
// trailing caret would show TWO carets while the box is focused and make the
// click feel like it did nothing.

import { useEffect, useState } from "react"
import { useReducedMotion } from "motion/react"
import { cn } from "@/lib/utils"
import {
  OVERLAY_FONT_SIZE,
  OVERLAY_MONO_CLASS,
  TEXTAREA_TYPOGRAPHY,
} from "../composer-chip-overlay"

const TYPE_MS = 42
const DELETE_MS = 16
const HOLD_MS = 2600
const GAP_MS = 500

type Phase = "typing" | "hold" | "deleting" | "gap"

interface ComposerHintCarouselProps {
  hints: readonly string[]
  /** Mirror the textarea's monospace family — see {@link OVERLAY_MONO_CLASS}. */
  mono?: boolean
  /** Mirror the textarea's trailing-inset reservation (corner controls). */
  padEndClass?: string
  /** Mirror the textarea's compact stacked layout (min-h-14 + py-1.5). */
  compactLayout?: boolean
  /**
   * Reports the FULL text of the hint currently on screen whenever it
   * changes — the composer uses it for Tab-to-accept, which fills the input
   * with the whole hint, not just the chars typed so far.
   */
  onActiveHint?: (hint: string) => void
}

export function ComposerHintCarousel({
  hints,
  mono,
  padEndClass,
  compactLayout,
  onActiveHint,
}: ComposerHintCarouselProps) {
  const reduce = useReducedMotion()
  const [index, setIndex] = useState(0)
  const [len, setLen] = useState(0)
  const [phase, setPhase] = useState<Phase>("typing")

  // `index % length` rather than a clamp effect: the hint list can shrink
  // (e.g. AI starters re-resolve) without a stale index painting.
  const hint = hints.length > 0 ? hints[index % hints.length] : ""

  useEffect(() => {
    onActiveHint?.(hint)
  }, [hint, onActiveHint])

  useEffect(() => {
    if (hints.length === 0) return
    const delay =
      phase === "typing"
        ? TYPE_MS
        : phase === "hold"
          ? HOLD_MS
          : phase === "deleting"
            ? DELETE_MS
            : GAP_MS
    const id = window.setTimeout(() => {
      switch (phase) {
        case "typing":
          // Reduced motion pops the whole hint in one step instead of
          // ticking a character at a time.
          if (len < hint.length) setLen(reduce ? hint.length : len + 1)
          else setPhase("hold")
          break
        case "hold":
          setPhase("deleting")
          break
        case "deleting":
          if (len > 0) setLen(reduce ? 0 : len - 1)
          else setPhase("gap")
          break
        case "gap":
          setIndex((index + 1) % hints.length)
          setPhase("typing")
          break
      }
    }, delay)
    return () => window.clearTimeout(id)
  }, [phase, len, index, hint, hints.length, reduce])

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden"
      data-testid="composer-hint-carousel"
    >
      <div
        className={cn(
          "block min-h-9 w-full break-words",
          compactLayout && "min-h-14 py-1.5",
          mono && OVERLAY_MONO_CLASS,
          TEXTAREA_TYPOGRAPHY,
          padEndClass
        )}
        style={{ fontSize: OVERLAY_FONT_SIZE }}
      >
        <span className="whitespace-pre-wrap break-words text-muted-foreground/70 line-clamp-2">
          {hint.slice(0, len)}
        </span>
      </div>
    </div>
  )
}
