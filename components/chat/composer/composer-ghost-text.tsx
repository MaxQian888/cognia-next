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
// The overlay also paints WITHOUT a ghost, for one case: `manualHint`. The
// agent tier only runs when asked, so its key has to be discoverable at the
// moment it is useful — which is precisely when the cheap tiers produced
// nothing and there is no ghost to hang a hint off.
//
// In `caret` mode the floating suggestion card owns the suggestion text and
// every chrome badge (source, position, hints), so this layer keeps only the
// transparent copy of `value` for alignment plus a pulse caret at the anchor.

import { forwardRef, memo } from "react"
import { motion } from "motion/react"
import { cn } from "@/lib/utils"
import {
  TEXTAREA_TYPOGRAPHY,
  OVERLAY_FONT_SIZE,
  OVERLAY_MONO_CLASS,
} from "../composer-chip-overlay"

interface ComposerGhostTextProps {
  /** The full textarea value the ghost trails. */
  value: string
  /**
   * Dim continuation rendered after `value` — or, when {@link caret} is set,
   * just the anchor position for it: the suggestion card paints the text
   * itself, and the inline layer shows only a pulse caret where it trails.
   */
  ghost: string
  /**
   * Caret-only mode: paint a pulsing block at the end of `value` instead of
   * the ghost text, which the floating suggestion card now owns.
   */
  caret?: boolean
  /**
   * Translated hint for the manually-requested agent tier — or its in-flight
   * label; the caller picks which, so this component stays a pure view. Shown
   * even when `ghost` is empty, which is the only case that paints the overlay
   * without a suggestion. Omit to hide.
   */
  manualHint?: string
  /** Mirror the textarea's monospace family — see {@link OVERLAY_MONO_CLASS}. */
  mono?: boolean
  /**
   * Right-side inset reserved for the box's floating corner controls, matching
   * whatever the textarea got. Same reason as the chip overlay: a different
   * wrap width puts the ghost on a different line from the caret it trails.
   */
  padEndClass?: string
}

const BADGE_CLASS =
  "ml-2 whitespace-nowrap rounded border border-border/60 bg-muted/70 px-1 text-[10px] leading-tight text-muted-foreground"

const ComposerGhostTextBase = forwardRef<HTMLDivElement, ComposerGhostTextProps>(
  function ComposerGhostText({ value, ghost, caret, manualHint, mono, padEndClass }, innerRef) {
    if (!ghost && !caret && !manualHint) return null
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
            mono && OVERLAY_MONO_CLASS,
            TEXTAREA_TYPOGRAPHY,
            padEndClass
          )}
          style={{ fontSize: OVERLAY_FONT_SIZE }}
        >
          <span className="text-transparent">{value}</span>
          {caret ? (
            // The suggestion card owns the text; inline keeps only a live
            // edge marker where the ghost would trail.
            <motion.span
              aria-hidden
              className="ms-px inline-block h-[1.05em] w-[2px] translate-y-[0.18em] rounded-full bg-primary/60"
              animate={{ opacity: [1, 0.2, 1] }}
              transition={{ duration: 1, repeat: Infinity, ease: "easeInOut" }}
            />
          ) : (
            <span className="text-muted-foreground/50">{ghost}</span>
          )}
          {manualHint ? (
            <span className={BADGE_CLASS} data-testid="composer-ghost-manual">
              {manualHint}
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
