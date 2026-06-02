// The pet's speech bubble. Presentational — the text + origin come from the store.

"use client"

import { cn } from "@/lib/utils"
import type { PetBubble } from "@/stores/pet/pet-store"

export function PetBubbleView({
  bubble,
  className,
}: {
  bubble: PetBubble | null
  className?: string
}) {
  if (!bubble) return null
  return (
    <div
      role="status"
      data-pet-bubble
      data-bubble-origin={bubble.origin}
      className={cn(
        "pointer-events-none max-w-[12rem] rounded-2xl border bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-md",
        "after:absolute after:-bottom-1 after:left-6 after:size-2 after:rotate-45 after:border-b after:border-r after:bg-popover",
        "relative",
        className
      )}
    >
      {bubble.text}
    </div>
  )
}
