"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleXIcon,
  Loader2Icon,
  TerminalIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import type { ToolCallEntry } from "@/lib/agent-team/team-runtime-dispatcher"

const MAX_PREVIEW_CHARS = 800

export interface ToolCallCardProps {
  call: ToolCallEntry
  className?: string
}

export function ToolCallCard({ call, className }: ToolCallCardProps) {
  const t = useTranslations("agentTeamsWorkspace.chat.toolCall")
  const [open, setOpen] = useState(false)

  const hasDetails = !!(call.input || call.output)

  return (
    <div
      data-testid={`tool-call-card-${call.id}`}
      data-status={call.status}
      className={cn(
        "rounded-md border bg-muted/30 text-[11px]",
        call.status === "error" && "border-destructive/40 bg-destructive/5",
        className
      )}
    >
      <button
        type="button"
        onClick={() => hasDetails && setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-1.5 px-2 py-1.5 text-left",
          hasDetails && "hover:bg-muted/60 cursor-pointer",
          !hasDetails && "cursor-default"
        )}
        aria-expanded={open}
        aria-label={t("toggleDetails", { name: call.name })}
        disabled={!hasDetails}
      >
        <StatusIcon status={call.status} />
        <TerminalIcon className="size-3 text-muted-foreground" aria-hidden />
        <span className="font-mono font-medium">{call.name}</span>
        <span className="ml-auto inline-flex items-center gap-1 text-muted-foreground">
          <span className="text-[10px]">{statusLabel(call.status, t)}</span>
          {hasDetails &&
            (open ? (
              <ChevronDownIcon className="size-3" />
            ) : (
              <ChevronRightIcon className="size-3" />
            ))}
        </span>
      </button>
      {open && hasDetails && (
        <div
          className="space-y-1.5 border-t px-2 py-1.5"
          data-testid={`tool-call-card-${call.id}-body`}
        >
          {call.input && (
            <div className="space-y-0.5">
              <p className="text-[10px] font-medium text-muted-foreground">{t("input")}</p>
              <pre className="overflow-x-auto rounded bg-background/80 px-2 py-1 font-mono text-[10px]">
                {truncate(call.input)}
              </pre>
            </div>
          )}
          {call.output && (
            <div className="space-y-0.5">
              <p className="text-[10px] font-medium text-muted-foreground">{t("output")}</p>
              <pre
                className={cn(
                  "max-h-48 overflow-auto rounded bg-background/80 px-2 py-1 font-mono text-[10px] whitespace-pre-wrap",
                  call.status === "error" && "text-destructive"
                )}
              >
                {truncate(call.output)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function StatusIcon({ status }: { status: ToolCallEntry["status"] }) {
  if (status === "running") {
    return <Loader2Icon className="size-3 animate-spin text-primary" aria-hidden />
  }
  if (status === "error") {
    return <CircleXIcon className="size-3 text-destructive" aria-hidden />
  }
  return <CircleCheckIcon className="size-3 text-emerald-500" aria-hidden />
}

function statusLabel(status: ToolCallEntry["status"], t: (k: string) => string): string {
  switch (status) {
    case "running":
      return t("running")
    case "error":
      return t("error")
    case "complete":
      return t("complete")
  }
}

function truncate(s: string): string {
  if (s.length <= MAX_PREVIEW_CHARS) return s
  return `${s.slice(0, MAX_PREVIEW_CHARS)}…`
}

export interface ToolCallListProps {
  calls: readonly ToolCallEntry[]
  className?: string
}

export function ToolCallList({ calls, className }: ToolCallListProps) {
  if (!calls || calls.length === 0) return null
  return (
    <div className={cn("space-y-1", className)} data-testid="tool-call-list">
      {calls.map((c) => (
        <ToolCallCard key={c.id} call={c} />
      ))}
    </div>
  )
}
