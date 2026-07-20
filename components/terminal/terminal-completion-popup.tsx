"use client"

/**
 * Multi-candidate completion popup for the integrated terminal
 * (ADR-0039 phase 2). Purely presentational: the parent
 * (`terminal-instance.tsx`) anchors it to the cursor pixel position and
 * the `AutocompleteController` owns all state — open/close, selection,
 * acceptance. The popup never takes focus (no tabindex; pointer events
 * only for click-to-accept), so typing keeps flowing into the PTY.
 *
 * Renders ABOVE the cursor line (the dock usually sits at the bottom of
 * the viewport) via `translateY(-100%)`.
 *
 * Safety: each row shows a warning badge when the command-safety
 * classifier returns an `ask` verdict for the candidate's resulting
 * line. (`deny` candidates are filtered out upstream by the hook.)
 */

import { useEffect, useMemo, useRef } from "react"
import {
  AlertTriangle,
  FileTerminal,
  FolderOpen,
  History,
  Puzzle,
  SquareTerminal,
  Sparkles,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { classifyCommand } from "@/lib/claude/permissions/command-safety"
import type { TerminalCompletionSuggestion } from "@/lib/terminal/completion/types"
import { cn } from "@/lib/utils"

import { completionListMaxHeight, TERMINAL_LAYOUT } from "./terminal-layout-tokens"

const SOURCE_ICONS: Record<
  TerminalCompletionSuggestion["source"],
  React.ComponentType<{ className?: string }>
> = {
  history: History,
  ai: Sparkles,
  plugin: Puzzle,
  path: FolderOpen,
  exe: SquareTerminal,
  spec: FileTerminal,
}

export interface TerminalCompletionPopupProps {
  candidates: TerminalCompletionSuggestion[]
  selectedIndex: number
  /** Pixel offset of the cursor within the terminal container. */
  left: number
  top: number
  /** Match the terminal font so candidate text lines up visually. */
  fontFamily: string
  fontSize: number
  /** Accept a candidate row by click (routes to acceptSelected). */
  onPick?: (index: number) => void
  className?: string
}

export function TerminalCompletionPopup({
  candidates,
  selectedIndex,
  left,
  top,
  fontFamily,
  fontSize,
  onPick,
  className,
}: TerminalCompletionPopupProps) {
  const t = useTranslations("terminal")
  const selectedRef = useRef<HTMLDivElement | null>(null)

  // Keep the highlighted row visible as the selection moves.
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" })
  }, [selectedIndex])

  // The classifier is pure + fast; memo per candidate list.
  const verdicts = useMemo(
    () => candidates.map((c) => classifyCommand(c.text).verdict),
    [candidates]
  )

  if (candidates.length === 0) return null

  // The popup renders above the cursor (`-translate-y-full`), so its full
  // height must fit in the space *above* the cursor or it clips against the
  // dock's `overflow-hidden` top edge in a short dock. Cap the scrollable list
  // to that space (see completionListMaxHeight).
  const listMaxHeight = completionListMaxHeight(top)

  return (
    <div
      data-testid="terminal-completion-popup"
      role="listbox"
      aria-label={t("popup.label")}
      className={cn(
        "absolute z-20 max-w-[90%] -translate-y-full overflow-hidden rounded-md border",
        TERMINAL_LAYOUT.completionPopupWidth,
        "border-border bg-popover text-popover-foreground shadow-md",
        className
      )}
      style={{ left, top: Math.max(0, top - 4) }}
    >
      <div className="overflow-y-auto py-1" style={{ maxHeight: listMaxHeight }}>
        {candidates.map((c, i) => {
          const Icon = SOURCE_ICONS[c.source]
          const selected = i === selectedIndex
          const display = c.replace ? c.replace.insert : c.text
          return (
            <div
              key={`${c.providerId}:${c.text}:${i}`}
              ref={selected ? selectedRef : undefined}
              role="option"
              aria-selected={selected}
              data-testid={`terminal-completion-candidate-${i}`}
              className={cn(
                "flex cursor-pointer items-center gap-2 px-2 py-1 text-xs",
                selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
              )}
              onMouseDown={(e) => {
                // mousedown (not click) so the terminal never loses focus.
                e.preventDefault()
                onPick?.(i)
              }}
            >
              <Icon className="size-3.5 shrink-0 text-muted-foreground" />
              <span
                className="min-w-0 flex-1 truncate"
                style={{ fontFamily, fontSize: Math.max(11, fontSize - 1) }}
                title={c.text}
              >
                {display}
              </span>
              {verdicts[i] === "ask" ? (
                <span
                  data-testid={`terminal-completion-ask-badge-${i}`}
                  title={t("popup.safetyAsk")}
                  className="flex shrink-0 items-center text-amber-500"
                >
                  <AlertTriangle className="size-3" aria-label={t("popup.safetyAsk")} />
                </span>
              ) : null}
              {c.description ? (
                <span className="max-w-[40%] shrink-0 truncate text-[10px] text-muted-foreground">
                  {c.description}
                </span>
              ) : (
                <span className="shrink-0 text-[10px] text-muted-foreground/70">
                  {t(`popup.source.${c.source}` as never)}
                </span>
              )}
            </div>
          )
        })}
      </div>
      <div className="border-t border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground">
        {t("popup.hint")}
      </div>
    </div>
  )
}
