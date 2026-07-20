"use client"

/**
 * Compact find-overlay rendered over the active TerminalInstance.
 *
 * Driven by `@xterm/addon-search` via the instance's imperative ref. The
 * dock owns one ref to the active instance and passes it down; the
 * overlay only needs the ref plus `open` / `onClose`.
 *
 * Keyboard:
 *   * Enter         → find next
 *   * Shift+Enter   → find previous
 *   * Esc           → close + clearDecorations
 *
 * Layout: floats above the terminal pixels in the upper-right, like VS
 * Code's "Find in Terminal" panel.
 */

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react"

import { MotionPopover } from "@/components/chat/motion/motion-reveal"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Toggle } from "@/components/ui/toggle"
import { cn } from "@/lib/utils"

import { TERMINAL_LAYOUT } from "./terminal-layout-tokens"
import type { TerminalInstanceHandle } from "./terminal-instance"

export interface TerminalSearchOverlayProps {
  open: boolean
  onClose: () => void
  /** Live ref to the instance the overlay drives. */
  instanceRef: React.RefObject<TerminalInstanceHandle | null>
  className?: string
}

export function TerminalSearchOverlay({
  open,
  onClose,
  instanceRef,
  className,
}: TerminalSearchOverlayProps) {
  const t = useTranslations("terminal.search")
  const [pattern, setPattern] = useState("")
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [matchFailed, setMatchFailed] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // When the overlay opens, focus and select existing pattern so the user
  // can type-replace. The close-side reset (clearSearch + drop the
  // match-failed flag) runs in the effect cleanup, which fires on the
  // open→closed transition without calling setState during render.
  useEffect(() => {
    if (!open) return
    // Capture the instance handle now so the cleanup clears search on the
    // exact terminal that was being searched — if the parent swaps the
    // active terminal before close, the new one was never searched here.
    const instance = instanceRef.current
    const id = window.setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => {
      window.clearTimeout(id)
      setMatchFailed(false)
      instance?.clearSearch()
    }
  }, [open, instanceRef])

  const findNext = () => {
    const ok = instanceRef.current?.findNext(pattern, caseSensitive) ?? false
    setMatchFailed(!ok && pattern.length > 0)
  }
  const findPrev = () => {
    const ok = instanceRef.current?.findPrevious(pattern, caseSensitive) ?? false
    setMatchFailed(!ok && pattern.length > 0)
  }

  return (
    <MotionPopover
      open={open}
      className={cn("pointer-events-auto absolute right-2 top-2 z-20", className)}
      from={{ opacity: 0, y: -6 }}
    >
      <div
        role="search"
        data-testid="terminal-search-overlay"
        className="flex items-center gap-1 rounded-md border bg-popover px-1.5 py-1 shadow"
      >
        <Input
          ref={inputRef}
          value={pattern}
          onChange={(e) => {
            setPattern(e.target.value)
            setMatchFailed(false)
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault()
              onClose()
            } else if (e.key === "Enter") {
              e.preventDefault()
              if (e.shiftKey) findPrev()
              else findNext()
            }
          }}
          placeholder={t("placeholder")}
          aria-label={t("placeholder")}
          data-testid="terminal-search-input"
          className={cn(
            "h-7 text-xs",
            TERMINAL_LAYOUT.searchInputWidth,
            matchFailed && "border-red-500 focus-visible:ring-red-500"
          )}
        />
        <Toggle
          size="sm"
          pressed={caseSensitive}
          onPressedChange={setCaseSensitive}
          aria-label={t("caseSensitive")}
          title={t("caseSensitive")}
          data-testid="terminal-search-case"
          className="h-7 w-7 px-0 text-[10px]"
        >
          Aa
        </Toggle>
        <Button
          size="icon"
          variant="ghost"
          onClick={findPrev}
          aria-label={t("previous")}
          data-testid="terminal-search-prev"
          className="h-7 w-7"
        >
          <ChevronUpIcon className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          onClick={findNext}
          aria-label={t("next")}
          data-testid="terminal-search-next"
          className="h-7 w-7"
        >
          <ChevronDownIcon className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          onClick={onClose}
          aria-label={t("close")}
          data-testid="terminal-search-close"
          className="h-7 w-7"
        >
          <XIcon className="h-3.5 w-3.5" />
        </Button>
      </div>
    </MotionPopover>
  )
}

export default TerminalSearchOverlay
