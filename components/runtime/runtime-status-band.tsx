"use client"

/**
 * One line of runtime status chrome at the top of the content area: what is
 * wrong with the Host connection (or the outbound queue), what that means for
 * the page under it, and the one action that helps.
 *
 * Two shells draw it. The compact shell's `OfflineBanner` owns the connection
 * report on a phone; the desktop-width `SurfaceAvailabilityBoundary` draws it
 * for a read-only route. They used to be two unrelated bands (an amber or red
 * strip from the banner, a grey Alert from the boundary) that stacked on the
 * same screen and disagreed in wording, so a phone showed "Reconnecting…" and
 * "Read-only mode: cached data stays readable" one above the other.
 *
 * Same visual vocabulary as the chat composer's runtime strip
 * (`mobile-chat-runtime-notice.tsx`): a neutral band, colour carried by the
 * icon alone, the state in medium weight, the consequence muted after a
 * middle dot, the action as a trailing text button.
 */

import type { ReactNode } from "react"
import { CloudOffIcon, EyeIcon, LoaderIcon, TriangleAlertIcon } from "lucide-react"

import { cn } from "@/lib/utils"

export type RuntimeStatusTone = "progress" | "offline" | "attention" | "info"

export interface RuntimeStatusBandProps {
  tone: RuntimeStatusTone
  /** The state, e.g. "Reconnecting to host". */
  title: string
  /** What it means here, e.g. "cached data only". Rendered after a middle dot. */
  detail?: string
  /** Paints `detail` as a problem (rows the Host refused). */
  detailAttention?: boolean
  /** Trailing text buttons or links; style them with {@link RUNTIME_BAND_ACTION}. */
  actions?: ReactNode
  className?: string
}

const TONE_ICON = {
  progress: LoaderIcon,
  offline: CloudOffIcon,
  attention: TriangleAlertIcon,
  info: EyeIcon,
} satisfies Record<RuntimeStatusTone, typeof LoaderIcon>

const TONE_ICON_CLASS: Record<RuntimeStatusTone, string> = {
  progress: "animate-spin text-amber-600 dark:text-amber-400",
  offline: "text-destructive",
  attention: "text-destructive",
  info: "text-muted-foreground",
}

/**
 * A text action at band height. `touch-hit` grows the hit area to the 44px
 * floor without growing the line, which keeps the band one row tall.
 */
export const RUNTIME_BAND_ACTION =
  "touch-hit shrink-0 rounded-md px-1.5 py-1 text-xs font-medium text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"

export function RuntimeStatusBand({
  tone,
  title,
  detail,
  detailAttention,
  actions,
  className,
}: RuntimeStatusBandProps) {
  const Icon = TONE_ICON[tone]
  return (
    <div
      data-testid="runtime-status-band"
      data-tone={tone}
      className={cn(
        "flex min-h-9 w-full items-center gap-2 border-b border-border/60 bg-muted/80 py-1 ps-3 pe-1.5 text-xs backdrop-blur-sm supports-[backdrop-filter]:bg-muted/60",
        className
      )}
    >
      <Icon aria-hidden className={cn("size-3.5 shrink-0", TONE_ICON_CLASS[tone])} />
      {/* One line, truncated: the band is chrome, and a second line pushed the
          page down by a different amount on every screen. The full text stays
          in the accessibility tree; truncation is visual only. */}
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-foreground">{title}</span>
        {detail ? (
          <span
            data-testid="runtime-status-band-detail"
            className={detailAttention ? "text-destructive" : "text-muted-foreground"}
          >
            {" · "}
            {detail}
          </span>
        ) : null}
      </span>
      {actions ? <span className="flex shrink-0 items-center gap-0.5">{actions}</span> : null}
    </div>
  )
}
