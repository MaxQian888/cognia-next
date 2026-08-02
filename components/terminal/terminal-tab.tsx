"use client"

/**
 * One tab in the terminal dock header. Shows the session title plus a
 * status indicator derived from OSC 633 events (idle / running / exited).
 *
 * Two interactive zones:
 *   * Clicking the body of the tab selects it.
 *   * Clicking the × kills + removes the session.
 */

import type { MouseEvent as ReactMouseEvent, Ref } from "react"

import { useTranslations } from "next-intl"
import { XIcon } from "lucide-react"

import { MotionStatusSwap } from "@/components/chat/motion/motion-reveal"
import { cn } from "@/lib/utils"
import { displayTitle, type TerminalSessionRow } from "@/stores/terminal/terminal-store"

export interface TerminalTabProps {
  row: TerminalSessionRow
  active: boolean
  onSelect: (id: string) => void
  onClose: (id: string) => void
  /** Right-click handler — used by the tab context menu (Wave 3A). */
  onContextMenu?: (e: ReactMouseEvent<HTMLDivElement>) => void
  /**
   * React 19 ref-as-prop. Required so a Radix `ContextMenuTrigger asChild`
   * parent — and dnd-kit's sortable wrapper — can anchor to the tab element.
   */
  ref?: Ref<HTMLDivElement>
  /** Renderer backpressure is holding this session's output back. */
  throttled?: boolean
  /**
   * Extra DOM props injected by an `asChild` / drag-listener parent
   * (`data-state`, `aria-*`, pointer handlers). Spread first so the tab's own
   * className and handlers still win.
   */
  [key: string]: unknown
}

export function TerminalTab({
  row,
  active,
  onSelect,
  onClose,
  onContextMenu,
  ref,
  throttled,
  ...rest
}: TerminalTabProps) {
  const t = useTranslations("terminal.tab")

  const statusKey =
    row.status === "running"
      ? "status.running"
      : row.status === "exited"
        ? row.exitCode === 0
          ? "status.exitedOk"
          : "status.exitedFail"
        : "status.idle"

  const dotClass =
    row.status === "running"
      ? "bg-blue-500"
      : row.status === "exited"
        ? row.exitCode === 0
          ? "bg-emerald-500"
          : "bg-red-500"
        : "bg-muted-foreground/60"

  return (
    <div
      {...rest}
      ref={ref}
      role="tab"
      data-testid="terminal-tab"
      data-id={row.id}
      data-active={active}
      data-status={row.status}
      data-agent-trusted={row.agentTrusted ? "true" : undefined}
      data-throttled={throttled ? "true" : undefined}
      aria-selected={active}
      onClick={() => onSelect(row.id)}
      onContextMenu={onContextMenu}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onSelect(row.id)
        }
      }}
      tabIndex={0}
      className={cn(
        "group flex shrink-0 items-center gap-1.5 rounded-t-md border-b-2 px-2.5 py-1.5 text-xs",
        "cursor-pointer transition-colors",
        active
          ? "border-b-foreground bg-background font-medium text-foreground"
          : "border-b-transparent text-muted-foreground hover:bg-muted/50",
        row.agentTrusted && "ring-1 ring-amber-500/40",
        // A throttled background tab must be legible without switching to it.
        throttled && "ring-1 ring-orange-500/50"
      )}
    >
      <MotionStatusSwap swapKey={`${row.status}:${row.exitCode ?? ""}`}>
        <span
          className={cn("inline-block h-1.5 w-1.5 rounded-full", dotClass)}
          aria-label={t(statusKey)}
          title={t(statusKey)}
        />
      </MotionStatusSwap>
      <span className="max-w-[180px] truncate">{displayTitle(row)}</span>
      <button
        type="button"
        aria-label={t("close")}
        onClick={(e) => {
          e.stopPropagation()
          onClose(row.id)
        }}
        className={cn(
          "ml-1 rounded p-0.5 opacity-0 transition-opacity hover:bg-muted",
          "group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100",
          active && "opacity-60"
        )}
      >
        <XIcon className="h-3 w-3" />
      </button>
    </div>
  )
}

export default TerminalTab
