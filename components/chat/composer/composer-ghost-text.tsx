// Inline "ghost text" layer painted over the composer textarea — the chat
// cousin of the terminal's `terminal-ghost-text.tsx`. The textarea stays the
// single source of truth; this overlay paints the dim continuation after the
// typed text (suggestions are append-only, so the ghost always follows the
// caret at the end of the value). Never captures pointer events and is
// aria-hidden — the readable text is the textarea on top.
//
// Alignment contract: identical typography + box model to the textarea (the
// shared TEXTAREA_TYPOGRAPHY + pre-wrap + width) so the ghost wraps glyph-for-
// glyph after the typed text. Vertical scroll is mirrored imperatively via
// `innerRef` (no React state, no re-render on scroll), exactly like the chip
// overlay.
//
// Beyond the ghost itself the badge row tells the user WHERE the suggestion
// came from (history / a command / the model), because the two tiers behave
// differently and look identical otherwise: a history completion is exact and
// free, a model completion is a guess that cost a call. When more than one
// candidate is ranked it also shows the position and the cycle hint.

import { forwardRef, memo } from "react"
import { cn } from "@/lib/utils"
import { TEXTAREA_TYPOGRAPHY, OVERLAY_FONT_SIZE } from "../composer-chip-overlay"

interface ComposerGhostTextProps {
  /** The full textarea value the ghost trails. */
  value: string
  /** Dim continuation rendered after `value`. Empty → nothing painted. */
  ghost: string
  /** Translated "Tab" accept hint shown as a small badge. Omit to hide. */
  acceptHint?: string
  /** Translated source label (e.g. "history", "AI"). Omit to hide. */
  sourceLabel?: string
  /** Translated `n/total` position, shown only when more than one candidate. */
  positionLabel?: string
  /** Translated "Alt+] to cycle" hint. Omit to hide. */
  cycleHint?: string
}

const BADGE_CLASS =
  "ml-2 whitespace-nowrap rounded border border-border/60 bg-muted/70 px-1 text-[10px] leading-tight text-muted-foreground"

const ComposerGhostTextBase = forwardRef<HTMLDivElement, ComposerGhostTextProps>(
  function ComposerGhostText(
    { value, ghost, acceptHint, sourceLabel, positionLabel, cycleHint },
    innerRef
  ) {
    if (!ghost) return null
    return (
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden"
        data-testid="composer-ghost-text"
        data-ghost={ghost}
        data-ghost-source={sourceLabel}
      >
        <div
          ref={innerRef}
          className={cn(
            "block min-h-9 w-full break-words whitespace-pre-wrap",
            TEXTAREA_TYPOGRAPHY
          )}
          style={{ fontSize: OVERLAY_FONT_SIZE }}
        >
          <span className="text-transparent">{value}</span>
          <span className="text-muted-foreground/50">{ghost}</span>
          {sourceLabel ? (
            <span className={BADGE_CLASS} data-testid="composer-ghost-source">
              {sourceLabel}
            </span>
          ) : null}
          {positionLabel ? (
            <span className={BADGE_CLASS} data-testid="composer-ghost-position">
              {positionLabel}
            </span>
          ) : null}
          {acceptHint ? <span className={BADGE_CLASS}>{acceptHint}</span> : null}
          {cycleHint ? (
            <span className={BADGE_CLASS} data-testid="composer-ghost-cycle">
              {cycleHint}
            </span>
          ) : null}
        </div>
      </div>
    )
  }
)

// Memoised: only re-render when the painted content changes, not on every
// composer re-render (caret, popover, status churn).
export const ComposerGhostText = memo(ComposerGhostTextBase)
