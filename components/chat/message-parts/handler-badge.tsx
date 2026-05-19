"use client"

/**
 * HandlerBadge — compact pill showing who currently "owns" the chat
 * turn. Default is the Copilot main agent; whenever a subagent in the
 * workflow-editor specialist set (designer / debugger / refactorer /
 * doc-writer) becomes active in `useSubagentRuntimeStore`, the badge
 * switches to its name so the user can see at a glance which prompt is
 * driving the next reply.
 *
 * Used by `session-bar.tsx` in the workflow editor's right-sidebar
 * chat tab, but kept here next to `subagent-part.tsx` so future chat
 * surfaces can reuse the same badge.
 */

import { useMemo } from "react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"

/**
 * Names that count as a "handover". The badge displays the latest
 * SubAgent whose `name` appears in this set. Default subset matches
 * the Workflow Copilot specialists (kept in sync with
 * `WORKFLOW_COPILOT_SUBAGENT_NAMES` in
 * lib/claude/agents/workflow-copilot-prompt.ts).
 */
const DEFAULT_TRACKED_NAMES = [
  "workflow-designer",
  "workflow-debugger",
  "workflow-refactorer",
  "workflow-doc-writer",
] as const

export interface HandlerBadgeProps {
  /** Label shown when no tracked subagent is active. */
  defaultLabel: string
  /** Names to track. Defaults to the four workflow specialists. */
  trackedNames?: readonly string[]
  /** Optional className for layout tuning. */
  className?: string
  /** Optional testid override. */
  "data-testid"?: string
}

export function HandlerBadge({
  defaultLabel,
  trackedNames = DEFAULT_TRACKED_NAMES,
  className,
  "data-testid": testId = "handler-badge",
}: HandlerBadgeProps) {
  const subAgents = useSubagentRuntimeStore((s) => s.subAgents)
  const tracked = useMemo(
    () => pickMostRecentTracked(subAgents, trackedNames),
    [subAgents, trackedNames]
  )
  const isHandover = tracked != null
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-6 gap-1 px-2 text-[10px] uppercase tracking-wide",
        isHandover ? "border-primary/40 bg-primary/5 text-primary" : "text-muted-foreground",
        className
      )}
      data-testid={testId}
      data-handover={isHandover ? "true" : "false"}
    >
      <span aria-hidden="true">🎭</span>
      <span>{tracked ?? defaultLabel}</span>
    </Badge>
  )
}

/**
 * Pure helper exported for unit tests. Picks the most recently-active
 * SubAgent whose `name` is in `trackedNames`. Returns the name as a
 * string, or `null` when no tracked subagent is registered.
 */
export function pickMostRecentTracked(
  subAgents: Record<string, { name?: string; lastActivityAt?: Date | string | number } | undefined>,
  trackedNames: readonly string[]
): string | null {
  const allow = new Set(trackedNames)
  let best: { name: string; ts: number } | null = null
  for (const candidate of Object.values(subAgents)) {
    if (!candidate?.name || !allow.has(candidate.name)) continue
    const ts = toMillis(candidate.lastActivityAt)
    if (ts == null) continue
    if (!best || ts > best.ts) best = { name: candidate.name, ts }
  }
  return best?.name ?? null
}

function toMillis(value: Date | string | number | undefined): number | null {
  if (value == null) return null
  if (value instanceof Date) return value.getTime()
  if (typeof value === "number") return value
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}
