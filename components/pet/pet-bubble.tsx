// The pet's speech bubble. Presentational — the text + origin come from the store.
//
// A bubble may also carry an action (e.g. "Open Insights" when a radar report
// lands). The button renders only when the host passes `onAction`: the host
// decides what "open the console" means where it lives (a router push in the
// main window, a bridge request from the overlay), and a surface that cannot
// act shows the text alone instead of a dead button.

"use client"

import { useTranslations } from "next-intl"

import type { PetBubbleAction } from "@/lib/pet/bubbles/action"
import { cn } from "@/lib/utils"
import type { PetBubble } from "@/stores/pet/pet-store"

export function PetBubbleView({
  bubble,
  className,
  onAction,
}: {
  bubble: PetBubble | null
  className?: string
  /** Run the bubble's action. Omit it and the action is not offered. */
  onAction?: (action: PetBubbleAction) => void
}) {
  const t = useTranslations("pet")
  if (!bubble) return null
  const action = onAction ? bubble.action : undefined
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
      {action ? (
        // The bubble itself stays click-through so it never blocks a drag of
        // the pet under it; only the button takes the pointer. A native button
        // gives Tab, Enter and Space for free, and nothing grabs focus on its
        // own, so a bubble appearing never steals the user's typing.
        <button
          type="button"
          data-pet-bubble-action={action.kind}
          onClick={() => onAction?.(action)}
          className={cn(
            "pointer-events-auto mt-1 block rounded-md px-1.5 py-0.5 font-medium text-primary underline-offset-2",
            "hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          )}
        >
          {t("bubbleAction.openConsole", { tab: t(`console.tabs.${action.tab}`) })}
        </button>
      ) : null}
    </div>
  )
}
