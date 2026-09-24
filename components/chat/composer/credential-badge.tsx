"use client"

/**
 * "No API key" — the one credential state that stops the next send.
 *
 * It sat in the chat header; with the header projected into the title bar a
 * red badge there read as window chrome shouting. The composer's status line
 * is where the send will fail, so this is where the warning belongs. Reactive
 * through `useCredentialStatus`, so a subscription bearer that lands after
 * boot clears it without a reload. Clicking it opens provider settings.
 *
 * It is a chip on the toolbar row like its neighbours — same 28px height, same
 * radius, a real `<button>` that takes keyboard focus. It used to be a pill
 * `Badge` (24px, fully rounded, a `span` with `role="button"` that Tab skipped),
 * the one control on the row that was neither the row's size nor reachable
 * without a pointer. On a narrow row it folds to the key glyph alone: the tint
 * still says "something is wrong", and the accessible name and tooltip still
 * say what — at 91px the words were what squeezed the model chip down to "(".
 */

import { KeyRoundIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useCredentialStatus } from "@/hooks/chat/use-credential-status"
import { COMPOSER_TOOLBAR_CHIP, COMPOSER_TOOLBAR_GLYPH } from "@/lib/chat/composer-skin"
import { cn } from "@/lib/utils"

interface Props {
  onOpenSettings?: () => void
  /** Key glyph only — the toolbar's fold ladder sets it on a narrow row. */
  glyph?: boolean
  className?: string
}

/**
 * Tinted, not solid. A filled red block sitting permanently in the composer's
 * status line read as an alarm going off rather than a state to fix; the tint
 * keeps it the loudest thing on the row without making the row about it.
 * Border + text carry the colour, so it survives a wallpaper behind the
 * translucent surface. After the chip class so the chip's muted text and
 * transparent border do not erase it.
 */
const DESTRUCTIVE_TINT =
  "shrink-0 border border-destructive/30 bg-destructive/10 text-destructive hover:border-destructive/40 hover:bg-destructive/20 hover:text-destructive dark:border-destructive/30 dark:bg-destructive/15 dark:hover:bg-destructive/25"

export function ComposerCredentialBadge({ onOpenSettings, glyph = false, className }: Props) {
  const t = useTranslations("chat.header")
  const { keyOk } = useCredentialStatus()
  if (keyOk !== false) return null
  const label = t("noApiKey")
  const classes = cn(
    COMPOSER_TOOLBAR_CHIP,
    "gap-1",
    DESTRUCTIVE_TINT,
    glyph && COMPOSER_TOOLBAR_GLYPH,
    className
  )
  const body = (
    <>
      <KeyRoundIcon aria-hidden className="size-3.5 shrink-0" />
      {glyph ? null : <span>{label}</span>}
    </>
  )
  const chip = onOpenSettings ? (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={classes}
      onClick={onOpenSettings}
      aria-label={glyph ? label : undefined}
      data-testid="composer-credential-badge"
      data-glyph={glyph || undefined}
    >
      {body}
    </Button>
  ) : (
    // Without somewhere to send the user it is a status, not a control — a
    // button that does nothing when pressed is the one thing worse than none.
    <span
      role="status"
      aria-label={label}
      className={cn(
        "inline-flex cursor-default items-center rounded-md",
        classes,
        // Keep the resting tint on hover: a status that lights up under the
        // pointer reads as something to click.
        "hover:border-destructive/30 hover:bg-destructive/10 dark:hover:bg-destructive/15"
      )}
      data-testid="composer-credential-badge"
      data-glyph={glyph || undefined}
    >
      {body}
    </span>
  )
  if (!glyph) return chip
  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  )
}
