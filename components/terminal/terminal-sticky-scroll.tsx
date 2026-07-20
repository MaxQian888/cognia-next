"use client"

/**
 * Sticky-scroll header for the integrated terminal (VS Code parity). While the
 * viewport is scrolled inside a command's output, `terminal-instance.tsx` pins
 * that command's prompt line here at the top of the viewport. Presentational:
 * the parent resolves which line to pin (`lib/terminal/sticky-scroll.ts`),
 * reads its text from the xterm buffer, and passes the matching font + theme
 * colors so the header visually continues the terminal surface. Clicking it
 * scrolls back to the command.
 */

import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"

import { TERMINAL_LAYOUT } from "./terminal-layout-tokens"

export interface TerminalStickyScrollProps {
  /** The pinned command's prompt-row text. */
  text: string
  /** Terminal font so the header lines up with the buffer rows. */
  fontFamily: string
  fontSize: number
  /** Resolved terminal background / foreground so it blends with the surface. */
  background: string
  foreground: string
  /** Scroll back to the pinned command. */
  onClick: () => void
  className?: string
}

export function TerminalStickyScroll({
  text,
  fontFamily,
  fontSize,
  background,
  foreground,
  onClick,
  className,
}: TerminalStickyScrollProps) {
  const t = useTranslations("terminal")
  if (!text.trim()) return null
  return (
    <button
      type="button"
      data-testid="terminal-sticky-scroll"
      aria-label={t("stickyScroll.label")}
      title={text}
      className={cn(
        "absolute inset-x-0 top-0 z-10 flex items-center overflow-hidden whitespace-pre px-2 text-left",
        TERMINAL_LAYOUT.stickyScrollHeight,
        "border-b border-border/40 shadow-sm",
        className
      )}
      style={{ fontFamily, fontSize, background, color: foreground }}
      onMouseDown={(e) => {
        // mousedown + preventDefault so the terminal keeps focus.
        e.preventDefault()
        onClick()
      }}
    >
      <span className="min-w-0 flex-1 truncate">{text}</span>
    </button>
  )
}

export default TerminalStickyScroll
