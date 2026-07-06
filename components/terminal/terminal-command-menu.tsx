"use client"

/**
 * Command actions menu for the integrated terminal (VS Code parity —
 * `DecorationAddon._getCommandActions`). Opened by clicking a command's gutter
 * decoration in `terminal-instance.tsx`; presentational + parent-controlled,
 * mirroring `terminal-completion-popup.tsx`. The parent owns the open state,
 * the anchor position, and the captured command line / output; this component
 * only renders the header (exit status + duration) and the action rows.
 *
 * Actions:
 *   * Rerun command — write the command line back into the PTY (+ Enter).
 *   * Copy command — the command line.
 *   * Copy output — the captured output rows.
 *   * Copy command and output — both, separated by a blank line.
 */

import { useEffect, useRef } from "react"
import { ClipboardCopy, FileOutput, FileText, RotateCcw } from "lucide-react"
import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"

export interface TerminalCommandMenuProps {
  /** The captured command line. Empty string when capture missed it. */
  commandLine: string
  /** Exit code (`null` while still running / unknown). */
  exitCode: number | null
  /** Wall-clock duration in ms, or null when timings are unavailable. */
  durationMs: number | null
  /** Whether the command produced any output (gates the copy-output rows). */
  hasOutput: boolean
  /** Pixel offset within the terminal container to anchor the menu. */
  left: number
  top: number
  onRerun: () => void
  onCopyCommand: () => void
  onCopyOutput: () => void
  onCopyCommandAndOutput: () => void
  onClose: () => void
  className?: string
}

/**
 * Human duration for the menu header. Sub-second renders as `ms`; otherwise as
 * a one-decimal `s`. Exported for unit testing.
 */
export function formatDuration(
  ms: number,
  t: (key: string, values?: Record<string, string>) => string
): string {
  if (ms < 1000) return t("commandMenu.durationMs", { value: String(Math.max(0, Math.round(ms))) })
  return t("commandMenu.durationSec", { value: (ms / 1000).toFixed(1) })
}

export function TerminalCommandMenu({
  commandLine,
  exitCode,
  durationMs,
  hasOutput,
  left,
  top,
  onRerun,
  onCopyCommand,
  onCopyOutput,
  onCopyCommandAndOutput,
  onClose,
  className,
}: TerminalCommandMenuProps) {
  const t = useTranslations("terminal")
  const menuRef = useRef<HTMLDivElement | null>(null)

  // Close on Escape; the backdrop handles outside clicks.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [onClose])

  const statusLabel =
    exitCode === null
      ? t("commandMenu.running")
      : exitCode === 0
        ? t("commandMenu.succeeded")
        : t("commandMenu.failed", { code: String(exitCode) })

  const canRerun = commandLine.trim().length > 0

  const rows: Array<{
    id: string
    icon: React.ComponentType<{ className?: string }>
    label: string
    onClick: () => void
    disabled?: boolean
  }> = [
    {
      id: "rerun",
      icon: RotateCcw,
      label: t("commandMenu.rerun"),
      onClick: onRerun,
      disabled: !canRerun,
    },
    {
      id: "copy-command",
      icon: ClipboardCopy,
      label: t("commandMenu.copyCommand"),
      onClick: onCopyCommand,
      disabled: !canRerun,
    },
    {
      id: "copy-output",
      icon: FileOutput,
      label: t("commandMenu.copyOutput"),
      onClick: onCopyOutput,
      disabled: !hasOutput,
    },
    {
      id: "copy-both",
      icon: FileText,
      label: t("commandMenu.copyCommandAndOutput"),
      onClick: onCopyCommandAndOutput,
      disabled: !hasOutput && !canRerun,
    },
  ]

  return (
    <>
      {/* Invisible backdrop — a click anywhere outside closes the menu. */}
      <div
        data-testid="terminal-command-menu-backdrop"
        className="fixed inset-0 z-20"
        onMouseDown={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div
        ref={menuRef}
        data-testid="terminal-command-menu"
        role="menu"
        aria-label={t("commandMenu.trigger")}
        className={cn(
          "absolute z-30 w-60 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md",
          className
        )}
        style={{ left, top: Math.max(0, top) }}
      >
        <div className="border-b border-border/60 px-2 py-1 text-[10px] text-muted-foreground">
          <span data-testid="terminal-command-menu-status">{statusLabel}</span>
          {durationMs != null ? (
            <span data-testid="terminal-command-menu-duration">
              {" "}
              · {formatDuration(durationMs, t)}
            </span>
          ) : null}
        </div>
        <div className="py-1">
          {rows.map((row) => {
            const Icon = row.icon
            return (
              <button
                key={row.id}
                type="button"
                role="menuitem"
                disabled={row.disabled}
                data-testid={`terminal-command-menu-${row.id}`}
                className={cn(
                  "flex w-full items-center gap-2 px-2 py-1 text-left text-xs",
                  row.disabled
                    ? "cursor-not-allowed text-muted-foreground/50"
                    : "cursor-pointer hover:bg-accent hover:text-accent-foreground"
                )}
                onMouseDown={(e) => {
                  // mousedown + preventDefault so the terminal keeps focus.
                  e.preventDefault()
                  if (row.disabled) return
                  row.onClick()
                  onClose()
                }}
              >
                <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{row.label}</span>
              </button>
            )
          })}
        </div>
      </div>
    </>
  )
}

export default TerminalCommandMenu
