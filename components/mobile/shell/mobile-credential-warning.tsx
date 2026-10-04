"use client"

/**
 * The app bar's missing-credential warning.
 *
 * It was a destructive `Badge` with a text label, allowed to shrink so the bar
 * would not overflow — and at 375px it shrank until it read "o API k", clipped
 * on both sides. A blocking warning has to stay legible, so it now degrades to
 * a key icon button (the 44px floor, never shrunk) and shows its label only
 * when the bar is wide enough for it (`showLabel`, from the shell's width
 * tiers). The icon keeps a localized name for assistive tech, a tooltip for a
 * pointer, and a long-press hint for a finger, where there is no hover.
 *
 * A tap opens the session sheet whose Account section resolves it.
 *
 * Tonal, not solid. A filled red pill was the loudest thing on the bar — louder
 * than the title it squeezed — while the composer below already wears its own
 * red key badge for the same fact. As an icon it is one more control of the
 * action cluster (same ghost button, same 44px box) that happens to be red; with
 * room it is a quiet tinted chip, painted at the bar's chip height with the
 * vertical hit-slop the other chips use.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { KeyRoundIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { LongPress } from "@/components/interactions/long-press"
import { cn } from "@/lib/utils"

/** How long a long-press keeps the hint on screen. */
export const CREDENTIAL_HINT_MS = 2500

export interface MobileCredentialWarningProps {
  /** Room for the text label as well as the icon. */
  showLabel: boolean
  onResolve: () => void
  className?: string
}

export function MobileCredentialWarning({
  showLabel,
  onResolve,
  className,
}: MobileCredentialWarningProps) {
  const t = useTranslations("mobile.shell")
  const [hintOpen, setHintOpen] = useState(false)
  // A long-press hint closes by itself; a hover/focus tooltip closes with it.
  const [pressedHint, setPressedHint] = useState(false)
  useEffect(() => {
    if (!pressedHint) return
    const timer = setTimeout(() => {
      setPressedHint(false)
      setHintOpen(false)
    }, CREDENTIAL_HINT_MS)
    return () => clearTimeout(timer)
  }, [pressedHint])

  const hint = t("noApiKeyHint")
  return (
    <Tooltip
      open={hintOpen}
      onOpenChange={(open) => {
        setHintOpen(open)
        if (!open) setPressedHint(false)
      }}
    >
      <LongPress
        onLongPress={() => {
          setHintOpen(true)
          setPressedHint(true)
        }}
        className={cn("flex shrink-0", className)}
      >
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size={showLabel ? "sm" : "icon"}
            onClick={onResolve}
            aria-label={hint}
            data-testid="mobile-no-api-key"
            data-compact={showLabel ? undefined : "true"}
            className={cn(
              "shrink-0 text-destructive hover:text-destructive",
              showLabel
                ? "touch-hit h-8 gap-1.5 rounded-full border border-destructive/25 bg-destructive/10 px-2.5 text-xs font-medium hover:bg-destructive/15"
                : "touch-target size-11 hover:bg-destructive/10"
            )}
          >
            <KeyRoundIcon className={showLabel ? "size-3.5" : "size-5"} aria-hidden />
            {showLabel ? <span className="whitespace-nowrap">{t("noApiKey")}</span> : null}
          </Button>
        </TooltipTrigger>
      </LongPress>
      <TooltipContent side="bottom" data-testid="mobile-no-api-key-hint">
        {hint}
      </TooltipContent>
    </Tooltip>
  )
}
