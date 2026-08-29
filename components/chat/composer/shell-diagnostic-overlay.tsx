"use client"

/**
 * Underlines for `!`-mode problems, painted in a layer aligned to the composer
 * textarea.
 *
 * Same alignment contract as `ComposerChipOverlay`: identical typography, box
 * model and wrap width, with vertical scroll mirrored imperatively by the
 * parent. A layer that wraps even slightly differently puts the squiggle under
 * the wrong word, which is worse than no squiggle at all — so this component
 * takes the same `mono` and `padEndClass` props and applies the same shared
 * constants rather than restating any of them.
 *
 * The underline is decoration and is `aria-hidden`; the same information
 * reaches assistive tech through the polite status region below it, because a
 * wavy border is not something a screen reader can report.
 */

import { forwardRef } from "react"

import {
  OVERLAY_FONT_SIZE,
  OVERLAY_MONO_CLASS,
  TEXTAREA_TYPOGRAPHY,
} from "@/components/chat/composer-chip-overlay"
import type { ShellDiagnostic } from "@/lib/shell-intelligence/types"
import { cn } from "@/lib/utils"

export interface ShellDiagnosticOverlayProps {
  /** The FULL textarea value — the layer must wrap exactly as the textarea does. */
  value: string
  /** Diagnostics with offsets already mapped into `value` coordinates. */
  diagnostics: readonly ShellDiagnostic[]
  /** Accessible name for the status region. */
  statusLabel: string
  /** Match the textarea's family, or every underline drifts off its word. */
  mono?: boolean
  /** Match the textarea's trailing inset, or the wrap width differs. */
  padEndClass?: string
  /** Stand down while something else is painting these glyphs. */
  hidden?: boolean
}

interface Piece {
  text: string
  diagnostic: ShellDiagnostic | null
}

/**
 * Cut `value` into underlined and plain runs.
 *
 * Overlapping and out-of-order diagnostics are handled by construction: ranges
 * are clamped into the value, sorted, and any that starts before the previous
 * one ended is skipped. A squiggle drawn over a stale range would sit under
 * text that has already changed, so dropping it is the honest outcome.
 */
export function sliceDiagnostics(value: string, diagnostics: readonly ShellDiagnostic[]): Piece[] {
  const ranges = diagnostics
    .map((d) => ({
      ...d,
      from: Math.max(0, Math.min(d.from, value.length)),
      to: Math.max(0, Math.min(d.to, value.length)),
    }))
    .filter((d) => d.to > d.from)
    .sort((a, b) => a.from - b.from || a.to - b.to)

  const pieces: Piece[] = []
  let at = 0
  for (const range of ranges) {
    if (range.from < at) continue
    if (range.from > at) pieces.push({ text: value.slice(at, range.from), diagnostic: null })
    pieces.push({ text: value.slice(range.from, range.to), diagnostic: range })
    at = range.to
  }
  if (at < value.length) pieces.push({ text: value.slice(at), diagnostic: null })
  return pieces
}

export const ShellDiagnosticOverlay = forwardRef<HTMLDivElement, ShellDiagnosticOverlayProps>(
  function ShellDiagnosticOverlay(
    { value, diagnostics, statusLabel, mono, padEndClass, hidden },
    innerRef
  ) {
    const pieces = diagnostics.length > 0 ? sliceDiagnostics(value, diagnostics) : null

    return (
      <>
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-0 z-[3] overflow-hidden",
            hidden && "invisible"
          )}
          data-testid="shell-diagnostic-overlay"
        >
          <div
            ref={innerRef}
            className={cn(
              "block min-h-9 w-full break-words whitespace-pre-wrap text-transparent",
              mono && OVERLAY_MONO_CLASS,
              TEXTAREA_TYPOGRAPHY,
              padEndClass
            )}
            style={{ fontSize: OVERLAY_FONT_SIZE }}
          >
            {pieces?.map((piece, index) =>
              piece.diagnostic ? (
                <span
                  key={index}
                  data-diagnostic={piece.diagnostic.code}
                  data-severity={piece.diagnostic.severity}
                  className="box-decoration-clone"
                  style={{
                    textDecorationLine: "underline",
                    textDecorationStyle: "wavy",
                    textDecorationSkipInk: "none",
                    textUnderlineOffset: "0.25em",
                    textDecorationColor:
                      piece.diagnostic.severity === "error"
                        ? "var(--destructive)"
                        : "var(--warning, var(--destructive))",
                  }}
                >
                  {piece.text}
                </span>
              ) : (
                <span key={index}>{piece.text}</span>
              )
            )}
          </div>
        </div>
        {/* The squiggle's accessible twin. Polite, so it never interrupts
            typing, and it reports the problems rather than the decoration. */}
        <div className="sr-only" role="status" aria-live="polite" aria-label={statusLabel}>
          {diagnostics.map((d) => d.message).join(" ")}
        </div>
      </>
    )
  }
)
