// Inline "ghost text" layer painted over the composer textarea — the chat
// cousin of the terminal's `terminal-ghost-text.tsx`. The textarea stays the
// single source of truth; this overlay paints the dim AI continuation after
// the typed text (suggestions are append-only, so the ghost always follows
// the caret at the end of the value). Never captures pointer events and is
// aria-hidden — the readable text is the textarea on top.
//
// Alignment contract: identical typography + box model to the textarea (the
// shared TEXTAREA_TYPOGRAPHY + pre-wrap + width) so the ghost wraps glyph-for-
// glyph after the typed text. Vertical scroll is mirrored imperatively via
// `innerRef` (no React state, no re-render on scroll), exactly like the chip
// overlay.

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
}

const ComposerGhostTextBase = forwardRef<HTMLDivElement, ComposerGhostTextProps>(
  function ComposerGhostText({ value, ghost, acceptHint }, innerRef) {
    if (!ghost) return null
    return (
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden"
        data-testid="composer-ghost-text"
        data-ghost={ghost}
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
          {acceptHint ? (
            <span className="ml-2 whitespace-nowrap rounded border border-border/60 bg-muted/70 px-1 text-[10px] leading-tight text-muted-foreground">
              {acceptHint}
            </span>
          ) : null}
        </div>
      </div>
    )
  }
)

// Memoised: only re-render when value/ghost/hint change, not on every composer
// re-render (caret, popover, status churn).
export const ComposerGhostText = memo(ComposerGhostTextBase)
