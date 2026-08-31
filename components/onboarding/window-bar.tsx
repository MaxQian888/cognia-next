"use client"

import { ArrowLeftIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { WindowControls, useWindowChromeMode } from "@/components/desktop/window-controls"
import { cn } from "@/lib/utils"

interface OnboardingWindowBarProps {
  /** Step back. Omitted on the first step, which has nowhere to go. */
  onBack?: () => void
  /** Steps raise this while a request is in flight. */
  busy?: boolean
}

/**
 * The takeover's own top row: back, wordmark, window buttons.
 *
 * **It replaces `TitleBar`, it does not sit under it.** `/onboarding`
 * suppresses the desktop chrome (`isOnboardingRoute` in `DesktopAppShell`), and
 * the app is a frameless Tauri window — so without this row a Windows/Linux
 * user has no drag region and no close button for the length of setup. That is
 * the load-bearing reason it exists; carrying the wordmark and Back is what it
 * does with the space it has to occupy anyway.
 *
 * **Transparent, not tinted.** The chrome it stands in for is `bg-muted/40`,
 * which reads as "not content" — correct for a workspace frame, wrong here,
 * where the flow *is* the content and a tinted strip would be the third
 * horizontal band on a screen that only needs one. It draws no border and no
 * background; only its height is real.
 *
 * **Back lives here, at one width.** The rail used to carry it above `md` and
 * the narrow progress bar carried a second copy below — two controls, two
 * testids, one behaviour. Hoisting it to the row that exists at every width
 * leaves one.
 */
export function OnboardingWindowBar({ onBack, busy = false }: OnboardingWindowBarProps) {
  const t = useTranslations("onboarding")
  const mode = useWindowChromeMode()

  return (
    <header
      data-tauri-drag-region
      data-testid="onboarding-window-bar"
      className={cn(
        "flex h-10 shrink-0 items-center gap-1 pr-1 select-none",
        // macOS draws its traffic lights over the content (see
        // `tauri.macos.conf.json`); without the reserve, Back sits under them.
        // Same 88px `TitleBar` reserves — this row stands in for that one, so a
        // narrower reserve here would move the wordmark between screens.
        mode === "traffic-lights" ? "pl-22" : "pl-3"
      )}
    >
      {onBack && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          onClick={onBack}
          disabled={busy}
          aria-label={t("back")}
          data-testid="onboarding-back"
        >
          <ArrowLeftIcon className="size-4" />
        </Button>
      )}
      <span className="truncate px-2 text-xs font-medium tracking-tight text-muted-foreground">
        {t("wordmark")}
      </span>
      {/* Claims the slack so the whole middle of the row stays draggable. */}
      <div data-tauri-drag-region className="h-full min-w-0 flex-1" />
      <WindowControls />
    </header>
  )
}
