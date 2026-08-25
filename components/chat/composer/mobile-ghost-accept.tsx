"use client"

// Mobile-only "accept / dismiss" control for the composer's inline ghost-text
// suggestion. On desktop the dim continuation is accepted with Tab and
// dismissed with Esc (handled in the composer's onKeyDown), but a touch device
// has neither key — so the suggestion would render yet be impossible to act on.
// This surfaces two real, focusable buttons whenever a ghost is present on
// mobile. The accept button also fires a light haptic tap (no-op off-mobile).

import { CheckIcon, XIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { impact } from "@/lib/capacitor/haptics"

interface MobileGhostAcceptProps {
  /** Render only when there is a ghost to act on (caller gates on platform). */
  visible: boolean
  /** Accept the dim continuation — caller writes it into the textarea. */
  onAccept: () => void
  /** Discard the suggestion. */
  onDismiss: () => void
}

export function MobileGhostAccept({ visible, onAccept, onDismiss }: MobileGhostAcceptProps) {
  const t = useTranslations("chat.composer")
  if (!visible) return null
  return (
    <div className="mt-1 flex items-center justify-end gap-1" data-testid="mobile-ghost-accept">
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="touch-target h-8 gap-1 rounded-pill px-3 text-xs"
        onClick={() => {
          onAccept()
          void impact("light")
        }}
        data-testid="mobile-ghost-accept-confirm"
      >
        <CheckIcon className="size-3.5" aria-hidden="true" />
        {t("ghostAccept")}
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="touch-target size-8 rounded-full text-muted-foreground"
        aria-label={t("ghostDismiss")}
        onClick={onDismiss}
        data-testid="mobile-ghost-accept-dismiss"
      >
        <XIcon className="size-3.5" aria-hidden="true" />
      </Button>
    </div>
  )
}
