"use client"

/**
 * The one frame every rich chat block draws in (ADR-0218): code, diff,
 * mermaid, math, tables and charts.
 *
 * Before it, each renderer hand-rolled its container, header and toolbar, so
 * radii (`md`/`lg`/`xl`), margins (`my-2`…`my-4`), header heights and five
 * toolbar button sizes drifted apart, and two toolbars ignored the
 * rich-controls setting. The frame owns all of that:
 *
 *   - `rounded-lg border bg-card`, with the vertical gap read from
 *     `--rich-block-gap` (the `blockDensity` setting, `app/typeset.css`);
 *   - a 32px header (`header="bar"`) with an icon, a label, muted meta and the
 *     actions, or no header with the actions floating over the body
 *     (`header="overlay"`, for blocks whose content IS the header: math);
 *   - actions carry `data-message-rich-control` and are hover-revealed on fine
 *     pointers, always shown on touch and while focused, so the
 *     rich-controls setting hides, reveals or pins every block's toolbar;
 *   - the `blockBorder` / `blockHeader` settings act through shell attributes
 *     (`app/globals.css`): with headers off the bar's title parts hide and its
 *     actions float inside the block as the same pill `overlay` draws, so the
 *     header DOM (`data-rich-block-header` / `-title` / `-actions`) is the
 *     contract that CSS relies on.
 *
 * It renders `not-typeset`, so the block's own `<pre>` / `<table>` never
 * inherit the prose rules around it.
 */

import { forwardRef, type HTMLAttributes, type ReactNode } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { HOVER_REVEAL_GROUP_BASE_CLASS } from "@/lib/ui/hover-reveal"
import { cn } from "@/lib/utils"

export type RichBlockKind =
  "code" | "diff" | "mermaid" | "math" | "table" | "chart" | "audio" | "details"

export interface RichBlockFrameProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  kind: RichBlockKind
  /** Leading glyph in the header bar. */
  icon?: ReactNode
  /** Header label (language, "Table", "Diagram"…). */
  label?: ReactNode
  /** Muted secondary text after the label (filename, row count…). */
  meta?: ReactNode
  /** `RichBlockAction` buttons. */
  actions?: ReactNode
  /** `bar` (default), `overlay` (actions float over the body) or `none`. */
  header?: "bar" | "overlay" | "none"
  /** Tighter frame for dense surfaces (tool cards). */
  compact?: boolean
  /** Content below the body (a truncation notice). */
  footer?: ReactNode
  bodyClassName?: string
  children: ReactNode
}

/**
 * The block toolbar's reveal: the shared four-way policy
 * (`lib/ui/hover-reveal.ts`) with the frame's own named group as the hover
 * path, so hovering an enclosing message row does not light up every block.
 */
export const RICH_BLOCK_ACTIONS_HOVER_CLASS = "group-hover/rich:opacity-100"

export const RichBlockFrame = forwardRef<HTMLDivElement, RichBlockFrameProps>(
  function RichBlockFrame(
    {
      kind,
      icon,
      label,
      meta,
      actions,
      header = "bar",
      compact = false,
      footer,
      className,
      bodyClassName,
      children,
      ...rest
    },
    ref
  ) {
    return (
      // Its own TooltipProvider: the app mounts one at the root, but a block can
      // render where none exists (a plugin surface, the SSR parity fixture),
      // and every action here is a tooltip button.
      <TooltipProvider>
        <div
          ref={ref}
          data-rich-block={kind}
          className={cn(
            "group/rich not-typeset relative min-w-0 overflow-hidden border bg-card text-card-foreground",
            compact ? "my-1 rounded-md" : "my-(--rich-block-gap) rounded-lg",
            className
          )}
          {...rest}
        >
          {header === "bar" ? (
            <div
              data-rich-block-header
              className={cn(
                "flex items-center gap-2 border-b bg-muted/50 text-muted-foreground",
                compact ? "h-7 px-2.5 text-[11px]" : "h-8 px-3 text-xs"
              )}
            >
              {icon ? (
                <span
                  data-rich-block-title
                  className="flex shrink-0 items-center [&_svg]:size-3.5"
                  aria-hidden
                >
                  {icon}
                </span>
              ) : null}
              {label ? (
                <span
                  data-rich-block-title
                  className="min-w-0 truncate font-medium text-foreground/80"
                >
                  {label}
                </span>
              ) : null}
              {meta ? (
                <span data-rich-block-title className="min-w-0 truncate text-muted-foreground/70">
                  {meta}
                </span>
              ) : null}
              {actions ? (
                <div
                  data-rich-block-actions
                  data-message-rich-control
                  className={cn(
                    "ms-auto flex items-center gap-0.5",
                    HOVER_REVEAL_GROUP_BASE_CLASS,
                    RICH_BLOCK_ACTIONS_HOVER_CLASS
                  )}
                >
                  {actions}
                </div>
              ) : null}
            </div>
          ) : null}
          {header === "overlay" && actions ? (
            <div
              data-message-rich-control
              className={cn(
                "absolute end-1.5 top-1.5 z-10 flex items-center gap-0.5 rounded-md border bg-background/85 p-0.5 shadow-xs backdrop-blur-sm",
                HOVER_REVEAL_GROUP_BASE_CLASS,
                RICH_BLOCK_ACTIONS_HOVER_CLASS
              )}
            >
              {actions}
            </div>
          ) : null}
          <div data-rich-block-body className={cn("min-w-0", bodyClassName)}>
            {children}
          </div>
          {footer}
        </div>
      </TooltipProvider>
    )
  }
)
