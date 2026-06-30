"use client"

/**
 * Terminal quick-fix affordance (VS Code parity). When a finished command
 * matches a built-in matcher (`lib/terminal/quick-fix/`), `terminal-instance.tsx`
 * anchors this lightbulb at the command's gutter row. Clicking it (or Ctrl+.)
 * opens a menu of the proposed {@link QuickFixAction}s; picking one dispatches
 * it through `onRun` (the parent writes to the PTY / opens the URL / kills the
 * port). Presentational + parent-controlled, like the completion popup.
 */

import { useEffect } from "react"
import { Lightbulb } from "lucide-react"
import { useTranslations } from "next-intl"

import type { QuickFixAction } from "@/lib/terminal/quick-fix/matchers"
import { cn } from "@/lib/utils"

export interface TerminalQuickFixProps {
  actions: QuickFixAction[]
  /** Pixel offset within the terminal container to anchor the lightbulb. */
  left: number
  top: number
  /** Dispatch a chosen action (parent performs the side effect). */
  onRun: (action: QuickFixAction) => void
  /** Controlled open state — the parent owns it so Ctrl+. can open the menu. */
  open: boolean
  onOpenChange: (open: boolean) => void
  className?: string
}

export function TerminalQuickFix({
  actions,
  left,
  top,
  onRun,
  open,
  onOpenChange,
  className,
}: TerminalQuickFixProps) {
  const t = useTranslations("terminal")

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        onOpenChange(false)
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [open, onOpenChange])

  if (actions.length === 0) return null

  function labelFor(action: QuickFixAction): string {
    return t(`quickFix.${action.labelKey}` as never, action.labelArgs ?? {})
  }

  return (
    <div className={cn("absolute z-30", className)} style={{ left, top: Math.max(0, top) }}>
      <button
        type="button"
        data-testid="terminal-quick-fix-trigger"
        aria-label={t("quickFix.trigger")}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex size-5 items-center justify-center rounded bg-amber-500/15 text-amber-500 shadow-sm hover:bg-amber-500/25"
        onMouseDown={(e) => {
          e.preventDefault()
          onOpenChange(!open)
        }}
      >
        <Lightbulb className="size-3.5" />
      </button>
      {open ? (
        <>
          <div
            data-testid="terminal-quick-fix-backdrop"
            className="fixed inset-0 z-20"
            onMouseDown={(e) => {
              e.preventDefault()
              onOpenChange(false)
            }}
          />
          <div
            data-testid="terminal-quick-fix-menu"
            role="menu"
            aria-label={t("quickFix.title")}
            className="absolute left-0 top-6 z-30 w-72 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md"
          >
            <div className="border-b border-border/60 px-2 py-1 text-[10px] font-medium text-muted-foreground">
              {t("quickFix.title")}
            </div>
            <div className="py-1">
              {actions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  role="menuitem"
                  data-testid={`terminal-quick-fix-action-${action.id}`}
                  className="flex w-full cursor-pointer items-center gap-2 px-2 py-1 text-left text-xs hover:bg-accent hover:text-accent-foreground"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    onRun(action)
                    onOpenChange(false)
                  }}
                >
                  <Lightbulb className="size-3 shrink-0 text-amber-500" />
                  <span className="min-w-0 flex-1 truncate" title={labelFor(action)}>
                    {labelFor(action)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}

export default TerminalQuickFix
