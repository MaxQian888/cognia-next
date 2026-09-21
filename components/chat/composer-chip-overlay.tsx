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
import type { SlashScope } from "@/lib/slash-commands/builtin"

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

/**
 * The command sigil, painted into the token's `/` cell as a mask so the mark
 * can take a Tailwind background colour and track the theme — a
 * background-image data URI cannot (the SVG document cannot see this one's
 * CSS variables, which is why {@link genericLinkIcon} ships one variant per
 * theme instead).
 *
 * A lightning bolt rather than the slash the user typed: the pill is the
 * affordance, so the sigil can spend its one cell saying "this executes"
 * instead of restating the punctuation.
 */
const COMMAND_SIGIL_MASK = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="black">' +
    '<path d="M13.2 2.2 4.6 14.1h6.2l-1.6 7.7 8.8-11.9h-6.2l1.4-7.7z"/></svg>'
)}")`

/**
 * Pill + sigil tones per command scope — where the command comes from is the
 * one fact a token in the text cannot otherwise tell you. `builtin` stays
 * neutral: it is the native default and colouring it would paint most pills.
 * Amber is deliberately absent — it already means "unresolved parameter".
 *
 * The fill is a whisper and the ring does the outlining: a heavier wash
 * (`bg-primary/10`-and-up) paints a milky slab over the composer's tinted
 * surface, which reads as a stray rectangle rather than a token. Text and the
 * sigil carry the colour; the box just bounds them.
 */
const COMMAND_SCOPE_TONE: Record<SlashScope, { pill: string; sigil: string }> = {
  builtin: {
    pill: "bg-foreground/[0.045] ring-foreground/15",
    sigil: "bg-foreground/55",
  },
  project: {
    pill: "bg-blue-500/[0.08] text-blue-700 ring-blue-500/35 dark:text-blue-300",
    sigil: "bg-blue-600/75 dark:bg-blue-400/75",
  },
  user: {
    pill: "bg-violet-500/[0.08] text-violet-700 ring-violet-500/35 dark:text-violet-300",
    sigil: "bg-violet-600/75 dark:bg-violet-400/75",
  },
  plugin: {
    pill: "bg-emerald-500/[0.08] text-emerald-700 ring-emerald-500/35 dark:text-emerald-300",
    sigil: "bg-emerald-600/75 dark:bg-emerald-400/75",
  },
}

/**
 * A command token's `/` cell, repainted as the scope-tinted bolt. The glyph
 * itself is transparent — the cell only reserves its exact advance so this
 * layer stays a character-for-character mirror of the textarea — and the mask
 * paints the mark over it. Same trick as {@link LinkMarker}: padding widens
 * the paint box for a mark slightly wider than `/`, and the matching negative
 * margin gives that width back so the next glyph does not move. `py` matches
 * the pill's so the mark centres in the capsule, not in the bare line box.
 */
function CommandSigil({ tone }: { tone: string }) {
  return (
    <span
      data-command-sigil
      className={cn("-mx-0.5 px-0.5 py-[3px] text-transparent", tone)}
      style={{
        WebkitMaskImage: COMMAND_SIGIL_MASK,
        maskImage: COMMAND_SIGIL_MASK,
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        maskPosition: "center",
        WebkitMaskSize: "0.75em 0.75em",
        maskSize: "0.75em 0.75em",
      }}
    >
      /
    </span>
  )
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
  /**
   * Command name → its scope (`builtin`/`project`/`user`/`plugin`), so the
   * pill can tint by provenance. Omitting it paints every command as builtin —
   * the neutral default a caller with no command map can safely fall back to.
   */
  commandScope?: (name: string) => SlashScope | undefined
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
    { value, segments, paramState, commandScope, mono, hidden, padEndClass },
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
                  //
                  // `py` is the capsule's height: vertical padding on an inline
                  // box paints past the line box without moving a glyph, which
                  // is the only direction this mirror may grow in. `ps`/`pe` +
                  // `-ms`/`-me` is the horizontal version of the same trick —
                  // the capsule borrows pixels of the whitespace beside it so
                  // the label does not touch the ring, while net advance stays
                  // zero and the mirror still lines up. The leading side borrows
                  // less than the trailing one: a command at column 0 would
                  // otherwise push its left ring past the text margin and into
                  // the box's padding, flush against the composer edge. The `/`
                  // cell renders as {@link CommandSigil} and the name takes the
                  // scope's text tone, so the two halves read icon-then-label.
                  // The radius follows the skin's inner curve but stays capped:
                  // a pill the size of a text line should look squared-off like
                  // the box around it, never a full capsule.
                  const headLen = 1 + seg.name.length // leading "/" + name
                  const rest = seg.raw.slice(headLen)
                  const scope = commandScope?.(seg.name) ?? "builtin"
                  const tone = COMMAND_SCOPE_TONE[scope]
                  return (
                    <Fragment key={`${seg.start}-${i}`}>
                      <span
                        data-chip="command"
                        data-scope={scope}
                        className={cn(
                          "-ms-[3px] -me-1 box-decoration-clone rounded-[min(4px,var(--composer-inner-radius,4px))] ps-[3px] pe-1 py-[3px] ring-1 ring-inset",
                          tone.pill
                        )}
                      >
                        <CommandSigil tone={tone.sigil} />
                        {seg.name}
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
