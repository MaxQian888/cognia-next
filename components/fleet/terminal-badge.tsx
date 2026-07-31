"use client"

/**
 * TerminalBadge — names the dispatch source of a fleet session (which
 * terminal app / editor launched the agent). The label is the runtime value
 * reported by the Rust classifier (`fleet/terminal.rs`) — a product name like
 * "iTerm2" / "VS Code", shown verbatim; the unknown case still displays the
 * raw `TERM_PROGRAM` so the source is never hidden.
 */

import { TerminalIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { TerminalSource } from "@/lib/fleet/types"

export function TerminalBadge({
  terminal,
  className,
}: {
  terminal: TerminalSource
  className?: string
}) {
  return (
    <span
      data-testid="terminal-badge"
      data-terminal-app={terminal.app}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md bg-white/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-white/70",
        className
      )}
    >
      <TerminalIcon aria-hidden className="size-2.5" />
      {terminal.label}
    </span>
  )
}

export default TerminalBadge
