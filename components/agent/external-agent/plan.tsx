"use client"

/**
 * External Agent Plan Component
 *
 * Displays the execution plan from ACP agents.
 * @see https://agentclientprotocol.com/protocol/agent-plan
 */

import { CheckCircle2, Circle, Loader2, SkipForward } from "lucide-react"
import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Progress } from "@/components/ui/progress"
import { cn } from "@/lib/utils"
import type { AcpPlanEntry, ExternalAgentPlanDocument } from "@/types/agent/external-agent"

// ============================================================================
// Types
// ============================================================================

export interface ExternalAgentPlanProps {
  /** Plan entries from the agent */
  entries: AcpPlanEntry[]
  /** Current step index (0-based) */
  currentStep?: number
  /** ACP identified file/Markdown plan to display when the plan is not item-based. */
  document?: ExternalAgentPlanDocument | null
  /** Whether to show compact view */
  compact?: boolean
  /** Custom class name */
  className?: string
}

// ============================================================================
// Status Icon Component
// ============================================================================

function StatusIcon({ status }: { status: AcpPlanEntry["status"] }) {
  switch (status) {
    case "completed":
      return <CheckCircle2 className="h-4 w-4 text-green-500" />
    case "in_progress":
      return <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />
    case "skipped":
      return <SkipForward className="h-4 w-4 text-muted-foreground" />
    case "pending":
    default:
      return <Circle className="h-4 w-4 text-muted-foreground" />
  }
}

// ============================================================================
// Priority Badge Component
// ============================================================================

function PriorityBadge({ priority }: { priority: AcpPlanEntry["priority"] }) {
  const variants: Record<AcpPlanEntry["priority"], "default" | "secondary" | "destructive"> = {
    high: "destructive",
    medium: "default",
    low: "secondary",
  }

  return (
    <Badge variant={variants[priority]} className="text-xs">
      {priority}
    </Badge>
  )
}

// ============================================================================
// Plan Entry Component
// ============================================================================

interface PlanEntryProps {
  entry: AcpPlanEntry
  index: number
  isActive: boolean
  compact?: boolean
}

function PlanEntry({ entry, index, isActive, compact }: PlanEntryProps) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-md p-2 transition-colors",
        isActive && "bg-accent",
        entry.status === "completed" && "opacity-60",
        entry.status === "skipped" && "opacity-40"
      )}
    >
      <div className="flex items-center gap-2 pt-0.5">
        <span className="text-xs text-muted-foreground w-4">{index + 1}</span>
        <StatusIcon status={entry.status} />
      </div>
      <div className="flex-1 min-w-0">
        <p
          className={cn(
            "text-sm",
            entry.status === "completed" && "line-through",
            compact && "truncate"
          )}
        >
          {entry.content}
        </p>
        {!compact && (
          <div className="flex items-center gap-2 mt-1">
            <PriorityBadge priority={entry.priority} />
          </div>
        )}
      </div>
    </div>
  )
}

// ============================================================================
// Main Component
// ============================================================================

export function ExternalAgentPlan({
  entries,
  currentStep,
  document,
  compact = false,
  className,
}: ExternalAgentPlanProps) {
  const t = useTranslations("externalAgent")

  if ((!entries || entries.length === 0) && !document) {
    return null
  }

  if (document) {
    const value = document.kind === "file" ? document.uri : document.content
    return (
      <div className={cn("rounded-lg border bg-card", className)}>
        <div className="border-b p-3">
          <h4 className="text-sm font-medium">{t("executionPlan")}</h4>
        </div>
        <pre
          className={cn(
            "max-h-[300px] overflow-auto whitespace-pre-wrap break-all p-3 text-xs",
            compact && "max-h-[160px]"
          )}
        >
          {value}
        </pre>
      </div>
    )
  }

  const completedCount = entries.filter((e) => e.status === "completed").length
  const progress = (completedCount / entries.length) * 100

  return (
    <div className={cn("rounded-lg border bg-card", className)}>
      <div className="p-3 border-b">
        <div className="flex items-center justify-between">
          <h4 className="font-medium text-sm">{t("executionPlan")}</h4>
          <span className="text-xs text-muted-foreground">
            {completedCount}/{entries.length} {t("stepsCompleted")}
          </span>
        </div>
        <Progress value={progress} className="mt-2 h-1" />
      </div>
      <ScrollArea className={cn(compact ? "h-[160px] md:h-[200px]" : "h-[220px] md:h-[300px]")}>
        <div className="p-2 space-y-1">
          {entries.map((entry, index) => (
            <PlanEntry
              key={`${index}-${entry.content.slice(0, 20)}`}
              entry={entry}
              index={index}
              isActive={currentStep === index}
              compact={compact}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}
