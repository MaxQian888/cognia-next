"use client"

import { ArrowLeftIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { WindowControls, useWindowChromeMode } from "@/components/desktop/window-controls"
import { cn } from "@/lib/utils"

export interface GuideWindowBarBack {
  onBack: () => void
  /** Accessible name of the button — it is an icon alone. */
  label: string
}

export interface GuideWindowBarProps {
  /** The product wordmark, already translated. */
  wordmark: string
  /**
   * Step back. Omitted where there is nowhere to go. Handler and label travel
   * together so a Back button can never render without an accessible name.
   */
  back?: GuideWindowBarBack
  /** Raised while a request is in flight; disables Back. */
  busy?: boolean
  /** Prefix for `${prefix}-window-bar` / `${prefix}-back`. */
  testIdPrefix: string
}

/**
 * A full-window guide's own top row: back, wordmark, window buttons
 * (ADR-0193, generalised from ADR-0122's onboarding window bar).
 *
 * **It replaces `TitleBar`, it does not sit under it.** Guided flows suppress
 * the desktop chrome, and the app is a frameless Tauri window — so without
 * this row a Windows/Linux user has no drag region and no close button for
 * the length of the flow. On the web and on a phone `WindowControls` renders
 * nothing, and the row is just the wordmark and Back — the same row in the
 * same place on every guided screen, which is the point.
 *
 * **Transparent, not tinted.** The chrome it stands in for is `bg-muted/40`,
 * which reads as "not content" — correct for a workspace frame, wrong here,
 * where the flow *is* the content. It draws no border and no background; only
 * its height is real.
 */
export function GuideWindowBar({
  wordmark,
  back,
  busy = false,
  testIdPrefix,
}: GuideWindowBarProps) {
  const mode = useWindowChromeMode()

  return (
    <header
      data-tauri-drag-region
      data-testid={`${testIdPrefix}-window-bar`}
      className={cn(
        "flex h-10 shrink-0 items-center gap-1 pr-1 select-none",
        // macOS draws its traffic lights over the content (see
        // `tauri.macos.conf.json`); without the reserve, Back sits under them.
        // Same 88px `TitleBar` reserves, so the wordmark does not move between
        // the app and a guided screen.
        mode === "traffic-lights" ? "pl-22" : "pl-3"
      )}
    >
      {back && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          onClick={back.onBack}
          disabled={busy}
          aria-label={back.label}
          data-testid={`${testIdPrefix}-back`}
        >
          <ArrowLeftIcon className="size-4" />
        </Button>
      )}
      <span className="truncate px-2 text-xs font-medium tracking-tight text-muted-foreground">
        {wordmark}
      </span>
      {/* Claims the slack so the whole middle of the row stays draggable. */}
      <div data-tauri-drag-region className="h-full min-w-0 flex-1" />
      <WindowControls />
    </header>
  )
}
