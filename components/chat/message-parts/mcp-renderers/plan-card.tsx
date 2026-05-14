"use client"

import { CheckCircle2Icon, CircleIcon, ClockIcon } from "lucide-react"
import type { ToolUIPart } from "ai"
import { McpCardShell } from "./common"
import { cn } from "@/lib/utils"

interface PlanStep {
  content?: string
  description?: string
  status?: "pending" | "in_progress" | "completed"
}

function statusIcon(status?: string) {
  if (status === "completed") {
    return <CheckCircle2Icon className="size-3.5 shrink-0 text-green-600" />
  }
  if (status === "in_progress") {
    return <ClockIcon className="size-3.5 shrink-0 animate-pulse text-yellow-600" />
  }
  return <CircleIcon className="size-3.5 shrink-0 text-muted-foreground" />
}

export function PlanCard({ part }: { part: ToolUIPart }) {
  // Plan input is shaped as { steps?: [...] } or { plan?: [...] } depending on
  // which sub-flavor of the tool emits it. The card normalises both.
  const input = (part.input ?? {}) as { steps?: PlanStep[]; plan?: PlanStep[] }
  const steps: PlanStep[] = Array.isArray(input.steps)
    ? input.steps
    : Array.isArray(input.plan)
      ? input.plan
      : []
  if (steps.length === 0) return null

  const completed = steps.filter((s) => s.status === "completed").length

  return (
    <McpCardShell title="Plan" badge={`${completed} / ${steps.length}`} testId="mcp-plan-card">
      <ul className="space-y-1">
        {steps.map((s, i) => (
          <li
            key={i}
            className={cn(
              "flex items-start gap-2",
              s.status === "completed" && "text-muted-foreground line-through"
            )}
            data-testid="mcp-plan-step"
            data-status={s.status ?? "pending"}
          >
            {statusIcon(s.status)}
            <span className="min-w-0 flex-1 break-words">{s.content ?? s.description ?? ""}</span>
          </li>
        ))}
      </ul>
    </McpCardShell>
  )
}
