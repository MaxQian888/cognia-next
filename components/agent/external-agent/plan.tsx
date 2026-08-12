"use client"

/** Displays item-based or document-based execution plans from ACP agents. */

import { CheckCircle2, Circle, Loader2, SkipForward } from "lucide-react"
import { useTranslations } from "next-intl"

import {
  Plan,
  PlanAction,
  PlanContent,
  PlanDescription,
  PlanHeader,
  PlanTitle,
  PlanTrigger,
} from "@/components/ai-elements/plan"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import type { AcpPlanEntry, ExternalAgentPlanDocument } from "@/types/agent/external-agent"

export interface ExternalAgentPlanProps {
  entries: AcpPlanEntry[]
  currentStep?: number
  document?: ExternalAgentPlanDocument | null
  compact?: boolean
  className?: string
}

function StatusIcon({ status }: { status: AcpPlanEntry["status"] }) {
  switch (status) {
    case "completed":
      return <CheckCircle2 className="size-4 text-green-500" />
    case "in_progress":
      return <Loader2 className="size-4 animate-spin text-blue-500" />
    case "skipped":
      return <SkipForward className="size-4 text-muted-foreground" />
    case "pending":
    default:
      return <Circle className="size-4 text-muted-foreground" />
  }
}

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

function PlanEntry({
  entry,
  index,
  isActive,
  compact,
}: {
  entry: AcpPlanEntry
  index: number
  isActive: boolean
  compact?: boolean
}) {
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
        <span className="w-4 text-xs text-muted-foreground">{index + 1}</span>
        <StatusIcon status={entry.status} />
      </div>
      <div className="min-w-0 flex-1">
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
          <div className="mt-1 flex items-center gap-2">
            <PriorityBadge priority={entry.priority} />
          </div>
        )}
      </div>
    </div>
  )
}

export function ExternalAgentPlan({
  entries,
  currentStep,
  document,
  compact = false,
  className,
}: ExternalAgentPlanProps) {
  const t = useTranslations("externalAgent")

  if ((!entries || entries.length === 0) && !document) return null

  if (document) {
    const value = document.kind === "file" ? document.uri : document.content
    return (
      <Plan className={className} defaultOpen>
        <PlanHeader className="border-b p-3">
          <PlanTitle>{t("executionPlan")}</PlanTitle>
          <PlanAction>
            <PlanTrigger label={t("togglePlan")} />
          </PlanAction>
        </PlanHeader>
        <PlanContent className="p-0">
          <pre
            className={cn(
              "max-h-[300px] overflow-auto whitespace-pre-wrap break-all p-3 text-xs",
              compact && "max-h-[160px]"
            )}
          >
            {value}
          </pre>
        </PlanContent>
      </Plan>
    )
  }

  const completedCount = entries.filter((entry) => entry.status === "completed").length
  const progress = (completedCount / entries.length) * 100

  return (
    <Plan
      className={className}
      defaultOpen
      isStreaming={entries.some((entry) => entry.status === "in_progress")}
    >
      <PlanHeader className="border-b p-3">
        <div className="min-w-0 flex-1">
          <PlanTitle>{t("executionPlan")}</PlanTitle>
          <PlanDescription className="mt-1">
            {`${completedCount}/${entries.length} ${t("stepsCompleted")}`}
          </PlanDescription>
          <Progress value={progress} className="mt-2 h-1" />
        </div>
        <PlanAction>
          <PlanTrigger label={t("togglePlan")} />
        </PlanAction>
      </PlanHeader>
      <PlanContent className="p-0">
        <ScrollArea className={cn(compact ? "h-[160px] md:h-[200px]" : "h-[220px] md:h-[300px]")}>
          <div className="space-y-1 p-2">
            {entries.map((entry, index) => (
              <PlanEntry
                key={`${index}-${entry.content.slice(0, 20)}`}
                compact={compact}
                entry={entry}
                index={index}
                isActive={currentStep === index}
              />
            ))}
          </div>
        </ScrollArea>
      </PlanContent>
    </Plan>
  )
}
