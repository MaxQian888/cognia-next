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

import { forwardRef } from "react"
import { cn } from "@/lib/utils"
import type { InputSegment } from "@/lib/slash-commands/parse-segments"

/**
 * Typography + box metrics shared by the textarea and this overlay. MUST stay
 * identical on both or the pills drift out from under the glyphs.
 */
export const TEXTAREA_TYPOGRAPHY = "px-1 py-1.5 pr-10 text-sm leading-6"

interface ComposerChipOverlayProps {
  value: string
  segments: InputSegment[]
}

export const ComposerChipOverlay = forwardRef<HTMLDivElement, ComposerChipOverlayProps>(
  function ComposerChipOverlay({ value, segments }, innerRef) {
    // Nothing to paint when there are no command segments — render an invisible
    // placeholder so the DOM node is stable but cheap.
    const hasCommand = segments.some((s) => s.kind === "command")

    return (
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden"
        data-testid="composer-chip-overlay"
      >
        <div
          ref={innerRef}
          className={cn(
            "block min-h-6 w-full break-words whitespace-pre-wrap text-transparent",
            TEXTAREA_TYPOGRAPHY
          )}
        >
          {hasCommand
            ? segments.map((seg, i) =>
                seg.kind === "command" ? (
                  <span
                    key={`${seg.start}-${i}`}
                    data-chip="command"
                    className="rounded-md bg-primary/15 ring-1 ring-primary/20 ring-inset"
                  >
                    {seg.raw}
                  </span>
                ) : (
                  <span key={`${seg.start}-${i}`}>{seg.value}</span>
                )
              )
            : // Keep the exact text so the box height matches the textarea even
              // before any command is recognised.
              value}
        </div>
      </div>
    )
  }
)
