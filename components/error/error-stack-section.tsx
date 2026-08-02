"use client"

/**
 * Flat error-detail section for the error page.
 *
 * Replaces the nested destructive `Alert` card the page used to embed: the
 * error page is already a bounded card, so a card-inside-a-card only added a
 * second border and stole horizontal space. This renders as a plain section —
 * a small label, the message on a destructive left rule, and a disclosure for
 * the stack — so it reads as part of the page rather than a widget dropped on
 * top of it.
 *
 * Expansion is the part that used to misbehave. The old collapsible clamped the
 * trace at `max-h-60` with its own `overflow-auto`, which nested a second
 * vertical scrollbar inside the page's scrollable detail band, and `break-all`
 * wrapping shredded frame paths mid-word. Here the trace scrolls **horizontally
 * only** (frames stay one line each, so they're readable and copyable) and grows
 * vertically inside the page band, keeping exactly one vertical scrollbar. On
 * open it scrolls itself into view so the newly revealed trace isn't left below
 * the fold.
 *
 * Provider-agnostic: all copy arrives as props so the `staticLocale="en"`
 * global-error path (no next-intl provider) renders it too.
 */

import { useCallback, useRef, useState } from "react"
import { ChevronDown } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export interface ErrorStackCopy {
  /** Section label, e.g. "Error details". */
  title: string
  showStack: string
  hideStack: string
}

export interface ErrorStackSectionProps {
  error: { message?: string; stack?: string }
  copy: ErrorStackCopy
  className?: string
}

const EMPTY_MESSAGE = "—"

/**
 * V8 stacks repeat the `Name: message` headline as their first line, which the
 * section already renders above the disclosure. Drop it so the trace starts at
 * the first frame instead of echoing the message.
 */
export function stripStackHeadline(stack: string, message: string): string {
  const lines = stack.split("\n")
  const first = lines[0]?.trim() ?? ""
  if (message && first.endsWith(message.trim()) && !first.startsWith("at ")) {
    return lines.slice(1).join("\n").replace(/^\n+/, "")
  }
  return stack
}

export function ErrorStackSection({ error, copy, className }: ErrorStackSectionProps) {
  const [open, setOpen] = useState(false)
  const traceRef = useRef<HTMLPreElement | null>(null)

  const message = error.message?.trim() ?? ""
  const stack = error.stack?.trim() ?? ""
  const frames = stack ? stripStackHeadline(stack, message) : ""

  const toggle = useCallback(() => {
    const next = !open
    setOpen(next)
    if (!next) return
    // Reveal the trace after it mounts — otherwise a long expansion opens below
    // the visible area of the page's scroll band.
    const reveal = () => traceRef.current?.scrollIntoView?.({ block: "nearest" })
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(reveal)
    } else {
      reveal()
    }
  }, [open])

  return (
    <section className={cn("px-5 py-4", className)} data-testid="error-stack-section">
      <h2 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {copy.title}
      </h2>
      <p
        className="mt-2 border-l-2 border-destructive/60 pl-3 text-sm break-words text-foreground"
        data-testid="error-stack-message"
      >
        {message || EMPTY_MESSAGE}
      </p>
      {frames && (
        <>
          <Button
            variant="ghost"
            size="sm"
            onClick={toggle}
            aria-expanded={open}
            className="mt-2 -ml-2 h-7 gap-1.5 px-2 text-xs text-muted-foreground"
            data-testid="error-stack-toggle"
          >
            <ChevronDown
              className={cn("size-3.5 transition-transform", open && "rotate-180")}
              aria-hidden="true"
            />
            {open ? copy.hideStack : copy.showStack}
          </Button>
          {open && (
            <pre
              ref={traceRef}
              className="mt-1 overflow-x-auto rounded-md bg-muted/50 p-3 font-mono text-[11px] leading-relaxed whitespace-pre text-muted-foreground"
              data-testid="error-stack-trace"
            >
              {frames}
            </pre>
          )}
        </>
      )}
    </section>
  )
}
