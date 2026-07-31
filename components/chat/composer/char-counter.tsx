"use client"

// Bottom-right character counter rendered as an overlay on the textarea.
// Stays muted under 8 000 characters, turns amber under 10 000, red beyond.

import { usePromptInputController } from "@/components/ai-elements/prompt-input"
import { cn } from "@/lib/utils"

const AMBER_THRESHOLD = 8_000
const RED_THRESHOLD = 10_000

export function CharCounter() {
  const controller = usePromptInputController()
  const len = controller.textInput.value.length
  if (len === 0) return null
  // Only announce to assistive tech once the count actually matters (nearing /
  // over the limit). A permanent `aria-live` would read the running total on
  // every single keystroke — a chatty a11y anti-pattern.
  const announce = len >= AMBER_THRESHOLD
  return (
    <span
      aria-live={announce ? "polite" : "off"}
      className={cn(
        // `end-2` (logical) keeps the counter in the trailing corner under RTL.
        "pointer-events-none absolute end-2 bottom-1 select-none text-[10px] tabular-nums text-muted-foreground/60",
        len >= AMBER_THRESHOLD && len < RED_THRESHOLD && "text-amber-500",
        len >= RED_THRESHOLD && "text-destructive"
      )}
    >
      {len.toLocaleString()}
    </span>
  )
}
