"use client"

/**
 * Cognia compat shim — minimal terminal-style output viewer used by
 * the canvas code-execution panel. cognia-next renders a simple
 * monospace block; the broader Cognia terminal (with PTY support,
 * search, etc.) is out of scope. The compound components below mirror
 * the Cognia surface so canvas's code-execution-panel compiles.
 */

import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

export interface TerminalProps {
  className?: string
  output?: string
  isStreaming?: boolean
  children?: React.ReactNode
}

export function Terminal({ className, children, output, isStreaming }: TerminalProps) {
  return (
    <ScrollArea
      className={cn(
        "h-full w-full rounded border bg-zinc-950 font-mono text-xs text-zinc-100",
        className
      )}
    >
      <div className="p-2">
        {output && <pre className="whitespace-pre-wrap">{output}</pre>}
        {children}
        {isStreaming && (
          <span className="inline-block h-3 w-1 animate-pulse bg-zinc-200 align-middle" />
        )}
      </div>
    </ScrollArea>
  )
}

export interface TerminalLineProps {
  stream?: "stdout" | "stderr" | "info"
  children: React.ReactNode
}

export function TerminalLine({ stream = "stdout", children }: TerminalLineProps) {
  return (
    <div
      className={cn(
        "whitespace-pre-wrap break-words",
        stream === "stderr" && "text-red-400",
        stream === "info" && "text-blue-300"
      )}
    >
      {children}
    </div>
  )
}

export function TerminalHeader({
  className,
  children,
}: {
  className?: string
  children?: React.ReactNode
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-2 border-b border-zinc-800 px-2 py-1 text-[11px] text-zinc-300",
        className
      )}
    >
      {children}
    </div>
  )
}

export function TerminalContent({
  className,
  children,
}: {
  className?: string
  children?: React.ReactNode
}) {
  return <div className={cn("min-h-0", className)}>{children}</div>
}

export function TerminalActions({
  className,
  children,
}: {
  className?: string
  children?: React.ReactNode
}) {
  return <div className={cn("flex items-center gap-1", className)}>{children}</div>
}

export function TerminalStatus({
  className,
  children,
  status,
}: {
  className?: string
  children?: React.ReactNode
  status?: "running" | "ok" | "error" | "idle"
}) {
  return (
    <div
      className={cn(
        "rounded px-1.5 py-0.5 text-[10px]",
        status === "running" && "bg-blue-500/20 text-blue-300",
        status === "ok" && "bg-emerald-500/20 text-emerald-300",
        status === "error" && "bg-red-500/20 text-red-300",
        !status && "bg-zinc-700/40 text-zinc-300",
        className
      )}
    >
      {children}
    </div>
  )
}

export default Terminal
