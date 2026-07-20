// Visual "command chip" layer painted behind the composer textarea. The
// textarea stays the single source of truth (it keeps its own glyphs, caret,
// IME, paste, draft, voice integrations); this overlay only paints a pill
// background under each `/command` token so a multi-command message reads like
// Slack / Raycast. It never captures pointer events and is aria-hidden — the
// readable text is the textarea on top.
//
// Alignment contract: the inner element copies the textarea's exact box model
// (the shared TEXTAREA_TYPOGRAPHY class + pre-wrap word-break + width) so line
// wrapping matches glyph-for-glyph. Vertical scroll is mirrored imperatively
// via `innerRef` (no React state, no re-render on scroll).

import { Fragment, forwardRef, memo } from "react"
import { cn } from "@/lib/utils"
import type { RichSegment } from "@/lib/slash-commands/parse-segments"

/**
 * Typography + box metrics shared by the textarea and this overlay. MUST stay
 * identical on both or the pills drift out from under the glyphs.
 */
// `pe-10` (logical padding-inline-end) reserves room for the CharCounter in the
// trailing corner so it stays clear of the text under both LTR and RTL.
export const TEXTAREA_TYPOGRAPHY = "px-1 py-1.5 pe-10 text-sm leading-6"

/**
 * The composer textarea's EFFECTIVE font size. A global, unlayered rule in
 * globals.css (`textarea, select { font-size: max(16px, 1rem) }`, the iOS
 * auto-zoom guard) overrides the `text-sm` in TEXTAREA_TYPOGRAPHY on the real
 * `<textarea>` — but NOT on these overlay `<div>`s. Applying the identical
 * expression as an inline style (which beats the class) keeps the overlays at
 * the textarea's true size so pills/ghost text line up glyph-for-glyph (a 14px
 * overlay over a 16px textarea drifts further the more you type).
 */
export const OVERLAY_FONT_SIZE = "max(16px, 1rem)"

interface ComposerChipOverlayProps {
  value: string
  /** Segments parsed with `{ mentions: true }` so `@mention` pills paint too. */
  segments: RichSegment[]
}

const ComposerChipOverlayBase = forwardRef<HTMLDivElement, ComposerChipOverlayProps>(
  function ComposerChipOverlay({ value, segments }, innerRef) {
    // Nothing to paint when there are no pill segments — render an invisible
    // placeholder so the DOM node is stable but cheap.
    const hasPill = segments.some((s) => s.kind === "command" || s.kind === "mention")

    return (
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden"
        data-testid="composer-chip-overlay"
      >
        {/*
          This layer paints ONLY pill backgrounds. Its text MUST stay fully
          transparent — the readable glyphs come from the textarea on top, which
          is a single color. Giving any span a visible text color double-renders
          the text behind the real one and shows as overlapping/ghosted glyphs.
        */}
        <div
          ref={innerRef}
          className={cn(
            "block min-h-6 w-full break-words whitespace-pre-wrap text-transparent",
            TEXTAREA_TYPOGRAPHY
          )}
          style={{ fontSize: OVERLAY_FONT_SIZE }}
        >
          {hasPill
            ? segments.map((seg, i) => {
                if (seg.kind === "command") {
                  // Pill wraps ONLY the `/command` token; its args render as
                  // plain (still transparent) text, so a line like
                  // `/reset ////////` shows a tight `/reset` chip instead of one
                  // huge pill over the slashes. `box-decoration-clone` keeps the
                  // rounded background intact if the chip ever wraps a line.
                  const headLen = 1 + seg.name.length // leading "/" + name
                  const head = seg.raw.slice(0, headLen)
                  const rest = seg.raw.slice(headLen)
                  return (
                    <Fragment key={`${seg.start}-${i}`}>
                      <span
                        data-chip="command"
                        className="box-decoration-clone rounded-md bg-primary/10 ring-1 ring-primary/15 ring-inset"
                      >
                        {head}
                      </span>
                      {rest ? <span>{rest}</span> : null}
                    </Fragment>
                  )
                }
                if (seg.kind === "mention") {
                  return (
                    <span
                      key={`${seg.start}-${i}`}
                      data-chip="mention"
                      className="box-decoration-clone rounded-md bg-muted/60 ring-1 ring-border ring-inset"
                    >
                      {seg.raw}
                    </span>
                  )
                }
                return <span key={`${seg.start}-${i}`}>{seg.value}</span>
              })
            : // Keep the exact text so the box height matches the textarea even
              // before any pill is recognised.
              value}
        </div>
      </div>
    )
  }
)

// Memoised: the overlay only needs to re-render when the value/segments change,
// not on every composer re-render (caret, popover, status churn).
export const ComposerChipOverlay = memo(ComposerChipOverlayBase)
