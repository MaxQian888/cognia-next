/**
 * The chat surface's reading column.
 *
 * The transcript rows (`message-list.tsx`), the composer (`composer.tsx`) and
 * the welcome state all cap at 52rem and then pad INSIDE that cap, so text,
 * bubbles and the input box share one content edge. Anything docked between
 * them — error cards, banners, status bars, plan docks — has to reuse the same
 * pair, otherwise it renders as a full-bleed band straddling a centred
 * conversation (the notice is 1.5-2x the width of the message it refers to on
 * a wide pane).
 *
 * Keep the padding inside the cap for the same reason the composer does: with
 * the padding on the outside the cap measures the padded box and the notice
 * runs 20px wider per side than the messages above it.
 */
import type { ComponentProps } from "react"

import { cn } from "@/lib/utils"

/** Cap + gutter shared by the transcript, the composer and every chat notice. */
export const chatColumnClass = "mx-auto w-full max-w-[52rem] px-3 sm:px-5"

/**
 * Wraps a docked chat notice into the reading column. `empty:hidden` keeps a
 * notice that renders `null` from contributing the wrapper's own vertical
 * margin — several of these (character-missing, work-submission, plan docks)
 * are self-hiding.
 */
export function ChatColumn({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="chat-notice-column"
      className={cn(chatColumnClass, "empty:hidden", className)}
      {...props}
    />
  )
}

export default ChatColumn
