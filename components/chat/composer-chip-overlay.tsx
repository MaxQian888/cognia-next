// Visual "command chip" layer painted behind the composer textarea. The
// textarea stays the single source of truth (it keeps its own glyphs, caret,
// IME, paste, draft, voice integrations); this overlay only paints a pill
// background under each `/command`, `@mention`, `{{param}}` and link token so a
// message with several of them reads like Slack / Raycast. It never captures pointer events and is aria-hidden — the
// readable text is the textarea on top.
//
// Alignment contract: the inner element copies the textarea's exact box model
// (the shared TEXTAREA_TYPOGRAPHY class + pre-wrap word-break + width) so line
// wrapping matches glyph-for-glyph. Vertical scroll is mirrored imperatively
// via `innerRef` (no React state, no re-render on scroll).

import { Fragment, forwardRef, memo } from "react"
import { cn } from "@/lib/utils"
import { brandIconAsset } from "@/components/icons/brand-icon"
import { brandIdForHost } from "@/lib/chat/link-display"
import { LINK_MARKER } from "@/lib/chat/link-fold"
import type { RichSegment } from "@/lib/slash-commands/parse-segments"

/**
 * Typography + box metrics shared by the textarea and this overlay. MUST stay
 * identical on both or the pills drift out from under the glyphs.
 */
// `pe-10` (logical padding-inline-end) reserves room for the CharCounter in the
// trailing corner so it stays clear of the text under both LTR and RTL.
export const TEXTAREA_TYPOGRAPHY = "px-1 py-1.5 pe-10 text-sm leading-6"

/**
 * The composer textarea's EFFECTIVE font size, which is NOT the `text-sm` in
 * TEXTAREA_TYPOGRAPHY on every shell.
 *
 * globals.css carries the iOS auto-zoom guard (`textarea, select { font-size:
 * max(16px, 1rem) }`) unlayered, so where it applies it outranks `text-sm` on
 * the real `<textarea>` — but never on these overlay `<div>`s, which are not
 * form controls. The guard is scoped to `(pointer: coarse), (hover: none)`, so
 * the textarea is 16px on a phone and 14px on a desktop, and an overlay pinned
 * to either number alone is wrong on the other shell. `--composer-text-size` is
 * declared beside the guard in both regimes and is the only thing that tracks
 * it; the fallback is the desktop answer, for a stylesheet that never loaded.
 *
 * This is a caret bug, not a cosmetic one: the textarea's glyphs are
 * transparent and these layers paint them, so a size mismatch leaves the caret
 * (still owned by the textarea) drifting further from the painted text with
 * every character — one full glyph in by the third one.
 */
export const OVERLAY_FONT_SIZE = "var(--composer-text-size, 0.875rem)"

/**
 * The other half of the alignment contract: the FAMILY.
 *
 * A skin may render the textarea in the code font (`mono: true` — `dense` and
 * `sharp` do). The overlays are separate elements, so they keep the UI sans
 * face unless told otherwise, and a proportional pill layer under monospace
 * glyphs drifts further from its token with every character on the line — the
 * second `/command` chip ends up covering the wrong span entirely. Every
 * overlay that mirrors the textarea takes this prop and applies it beside
 * {@link TEXTAREA_TYPOGRAPHY}.
 */
export const OVERLAY_MONO_CLASS = "font-mono"

/**
 * How a `{{parameter}}` pill should read.
 *
 * - `empty` — declared or typed, no value yet. A dashed outline, so an unfilled
 *   slot is visible at a glance without shouting.
 * - `filled` — a value is bound. Same treatment as a `/command` pill.
 * - `unresolved` — a value is bound but its target is gone on this device (an
 *   imported template naming a file, agent or workspace that does not exist
 *   here). Amber, because the send path will fall back to the stored label and
 *   the user should know before it does, not after.
 */
export type ParamPillState = "empty" | "filled" | "unresolved"

/**
 * Generic link glyph, for a host with no brand mark of its own. Inlined as a
 * data URI because this is a CSS background, which cannot take `currentColor` —
 * hence one variant per theme rather than a single tinted icon.
 */
function genericLinkIcon(color: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" ` +
    `stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><path d="M8 12h8"/></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}

const GENERIC_LINK_LIGHT = genericLinkIcon("#2563eb")
const GENERIC_LINK_DARK = genericLinkIcon("#60a5fa")

/**
 * The folded label's first character, painted over with the site's icon.
 *
 * The glyph itself renders transparent — the cell exists only to reserve
 * exactly one character of space in a layer that must match the textarea
 * glyph for glyph. Horizontal padding with a matching negative margin lets a
 * slightly wider mark breathe without taking any layout width.
 */
function LinkMarker({ url }: { url?: string }) {
  let brand: { src: string; mono: boolean } | null = null
  if (url) {
    try {
      brand = brandIconAsset(brandIdForHost(new URL(url).hostname))
    } catch {
      brand = null
    }
  }
  return (
    <span
      data-link-icon={brand ? "brand" : "generic"}
      className={cn(
        // Left-aligned inside its two cells: the mark takes the first, and what
        // is left of the second becomes the gap before the label.
        "bg-left bg-no-repeat align-baseline text-transparent no-underline [background-size:0.9em]",
        // A monochrome mark is black artwork; on a dark surface it has to flip.
        brand?.mono && "dark:invert",
        // Theme-swapped generic glyph (a background cannot use currentColor).
        !brand &&
          "[background-image:var(--composer-link-icon-light)] dark:[background-image:var(--composer-link-icon-dark)]"
      )}
      style={
        brand
          ? { backgroundImage: `url("${brand.src}")` }
          : ({
              "--composer-link-icon-light": GENERIC_LINK_LIGHT,
              "--composer-link-icon-dark": GENERIC_LINK_DARK,
            } as React.CSSProperties)
      }
    >
      {LINK_MARKER}
    </span>
  )
}

const PARAM_PILL_CLASS: Record<ParamPillState, string> = {
  empty: "border border-dashed border-muted-foreground/50",
  filled: "bg-primary/10 ring-1 ring-primary/25 ring-inset",
  unresolved: "bg-amber-500/10 ring-1 ring-amber-500/40 ring-inset",
}

interface ComposerChipOverlayProps {
  value: string
  /** Segments parsed with `{ mentions: true }` so `@mention` pills paint too. */
  segments: RichSegment[]
  /**
   * State of each `{{parameter}}` token. Defaults to `empty`, which is the
   * honest answer before anything has bound a value — including for a token the
   * user simply typed, which is a parameter exactly like one a template
   * inserted.
   */
  paramState?: (paramId: string) => ParamPillState
  /** Mirror the textarea's monospace family — see {@link OVERLAY_MONO_CLASS}. */
  mono?: boolean
  /**
   * Stop painting, without unmounting.
   *
   * Used while an IME composition is in flight: this layer only ever sees the
   * COMMITTED value, so it cannot show the candidate text mid-composition. The
   * textarea takes its own glyphs back for those keystrokes and this one steps
   * aside. It stays mounted so the scroll-mirror ref and the layout stay put.
   */
  hidden?: boolean
  /**
   * Right-side inset reserved for the box's floating corner controls
   * (`pe-*`), overriding {@link TEXTAREA_TYPOGRAPHY}'s default. It MUST be the
   * same value the textarea gets: this layer mirrors the textarea glyph for
   * glyph, so a different wrap width drifts every pill off its word.
   */
  padEndClass?: string
}

const ComposerChipOverlayBase = forwardRef<HTMLDivElement, ComposerChipOverlayProps>(
  function ComposerChipOverlay(
    { value, segments, paramState, mono, hidden, padEndClass },
    innerRef
  ) {
    // Nothing to paint when there are no pill segments — render an invisible
    // placeholder so the DOM node is stable but cheap.
    const hasPill = segments.some(
      (s) => s.kind === "command" || s.kind === "mention" || s.kind === "param" || s.kind === "link"
    )

    return (
      <div
        aria-hidden="true"
        // Above the textarea (`z-[1]`): the selection highlight is painted by
        // the textarea, and a text layer underneath it would disappear the
        // moment anything was selected.
        className={cn(
          "pointer-events-none absolute inset-0 z-[2] overflow-hidden",
          hidden && "invisible"
        )}
        data-testid="composer-chip-overlay"
        data-hidden={hidden || undefined}
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
          {hasPill
            ? segments.map((seg, i) => {
                if (seg.kind === "command") {
                  // Pill wraps ONLY the `/command` token; its args render as
                  // plain text, so a line like
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
                if (seg.kind === "param") {
                  // The pill paints `{{id}}` itself — it cannot show the value
                  // instead. This layer is a character-for-character mirror of
                  // the textarea, so any glyph it renders that the textarea does
                  // not have shifts every pill after it out of alignment.
                  const state = paramState?.(seg.paramId) ?? "empty"
                  return (
                    <span
                      key={`${seg.start}-${i}`}
                      data-chip="param"
                      data-param-state={state}
                      className={cn("box-decoration-clone rounded-md", PARAM_PILL_CLASS[state])}
                    >
                      {seg.raw}
                    </span>
                  )
                }
                if (seg.kind === "link") {
                  // A link reads the way links read everywhere else: blue and
                  // underlined. No pill — the text here is already the short
                  // label (`lib/chat/link-fold.ts` folded the URL down to it),
                  // so a box around it would be one decoration too many.
                  //
                  // The label's first character is the marker cell; the site's
                  // own mark is painted INTO it as a background, which is the
                  // only way to show an icon without adding a glyph the
                  // textarea does not have.
                  const hasMarker = seg.raw.startsWith(LINK_MARKER)
                  const rest = hasMarker ? seg.raw.slice(LINK_MARKER.length) : seg.raw
                  return (
                    <span
                      key={`${seg.start}-${i}`}
                      data-chip="link"
                      className="text-blue-600 underline decoration-blue-600/50 underline-offset-2 dark:text-blue-400 dark:decoration-blue-400/50"
                    >
                      {hasMarker ? <LinkMarker url={seg.url} /> : null}
                      {rest}
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
