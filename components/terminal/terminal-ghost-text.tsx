"use client"

/**
 * Inline "ghost text" overlay for the integrated terminal's Copilot-style
 * autocomplete (ADR-0039). Purely presentational: the parent
 * (`terminal-instance.tsx`) computes the pixel position from the xterm
 * cursor and feeds the suffix + labels in. Renders nothing when there's no
 * suffix to show.
 *
 * `pointer-events: none` so it never intercepts terminal mouse selection;
 * it sits above the xterm screen layer and inherits the terminal font so
 * the suffix lines up cell-for-cell with the real cursor.
 */

import { cn } from "@/lib/utils"

export interface TerminalGhostTextProps {
  /** The suffix to render after the cursor. Empty → nothing rendered. */
  ghost: string
  /** Pixel offset of the cursor within the terminal container. */
  left: number
  top: number
  /** Match the terminal font so glyphs align with real cells. */
  fontFamily: string
  fontSize: number
  /** Where the suggestion came from — drives the small badge. */
  source?: "history" | "ai" | "plugin"
  /** Translated hint shown in the badge (e.g. "Tab"). Omit to hide. */
  acceptHint?: string
  className?: string
}

export function TerminalGhostText({
  ghost,
  left,
  top,
  fontFamily,
  fontSize,
  source,
  acceptHint,
  className,
}: TerminalGhostTextProps) {
  if (!ghost) return null
  return (
    <div
      data-testid="terminal-ghost-text"
      data-source={source}
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute z-10 flex items-center whitespace-pre",
        className
      )}
      style={{ left, top, fontFamily, fontSize, lineHeight: `${fontSize}px` }}
    >
      <span className="text-muted-foreground/50">{ghost}</span>
      {acceptHint ? (
        <span
          className="ml-2 rounded border border-border/60 bg-muted/70 px-1 text-[10px] leading-tight text-muted-foreground"
          style={{ fontFamily: "inherit" }}
        >
          {acceptHint}
        </span>
      ) : null}
    </div>
  )
}
