"use client"

/**
 * Plan view component — renders the execution plan with step cards
 * and action buttons.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CircleIcon,
  LoaderIcon,
  PencilIcon,
  SkipForwardIcon,
  XCircleIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import type { ExecutionPlan, ErrorAdvisory, StepStatus } from "@/lib/terminal/ai-shell"

export interface AiShellPlanViewProps {
  plan: ExecutionPlan
  generating: boolean
  executing: boolean
  advisory: ErrorAdvisory | null
  advisoryLoading: boolean
  onRunAll: () => void
  onRunNext: () => void
  onSkip: (index: number) => void
  onEdit: (index: number, command: string) => void
  onCancel: () => void
  onRequestAdvisory: (stepIndex: number) => void
  onApplyFix: () => void
}

function StepStatusIcon({ status }: { status: StepStatus }) {
  switch (status) {
    case "pending":
      return <CircleIcon className="h-3 w-3 text-muted-foreground" />
    case "running":
      return <LoaderIcon className="h-3 w-3 animate-spin text-primary" />
    case "succeeded":
      return <CheckCircle2Icon className="h-3 w-3 text-emerald-500" />
    case "failed":
      return <XCircleIcon className="h-3 w-3 text-destructive" />
    case "skipped":
      return <SkipForwardIcon className="h-3 w-3 text-muted-foreground" />
    case "cancelled":
      return <XCircleIcon className="h-3 w-3 text-muted-foreground" />
  }
}

export function AiShellPlanView({
  plan,
  generating,
  executing,
  advisory,
  advisoryLoading,
  onRunAll,
  onRunNext,
  onSkip,
  onEdit,
  onCancel,
  onRequestAdvisory,
  onApplyFix,
}: AiShellPlanViewProps) {
  const t = useTranslations("terminal.aiShell")
  const [editingIdx, setEditingIdx] = useState<number | null>(null)
  const [editValue, setEditValue] = useState("")

  const hasPendingSteps = plan.steps.some((s) => s.status === "pending")
  const startEdit = (index: number) => {
    setEditingIdx(index)
    setEditValue(plan.steps[index].command)
  }

  const commitEdit = (index: number) => {
    if (editValue.trim()) {
      onEdit(index, editValue.trim())
    }
    setEditingIdx(null)
  }

  return (
    <div className="mt-2 rounded-md border bg-muted/30 p-2" data-testid="ai-shell-plan">
      {/* Plan header */}
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {t("plan.title")}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {generating
            ? t("plan.generating")
            : plan.status === "completed"
              ? t("plan.completed")
              : plan.status === "cancelled"
                ? t("plan.cancelled")
                : plan.status === "error"
                  ? t("plan.error")
                  : hasPendingSteps
                    ? t("plan.ready")
                    : t("plan.completed")}
        </span>
      </div>

      {/* Steps */}
      {plan.steps.length === 0 && !generating ? (
        <p className="py-2 text-center text-[10px] text-muted-foreground">{t("plan.empty")}</p>
      ) : (
        <ol className="space-y-1" data-testid="ai-shell-steps">
          {plan.steps.map((step) => (
            <li
              key={step.index}
              className="flex items-start gap-1.5 rounded px-1.5 py-1 text-[10px] hover:bg-muted/50"
              data-testid={`ai-shell-step-${step.index}`}
            >
              <StepStatusIcon status={step.status} />
              <div className="flex-1 min-w-0">
                {editingIdx === step.index ? (
                  <input
                    type="text"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={() => commitEdit(step.index)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitEdit(step.index)
                      if (e.key === "Escape") setEditingIdx(null)
                    }}
                    className="w-full rounded border bg-background px-1 py-0.5 font-mono text-[10px]"
                    autoFocus
                    data-testid="ai-shell-step-edit-input"
                  />
                ) : (
                  <>
                    <code className="block truncate font-mono">{step.command}</code>
                    {step.description && (
                      <span className="text-muted-foreground">{step.description}</span>
                    )}
                  </>
                )}
                {/* Failed step — show output snippet */}
                {step.status === "failed" && step.outputSnippet && (
                  <pre className="mt-0.5 max-h-16 overflow-auto rounded bg-destructive/5 px-1 py-0.5 text-[9px] text-destructive">
                    {step.outputSnippet}
                  </pre>
                )}
              </div>
              {/* Per-step actions */}
              {step.status === "pending" && !executing && (
                <div className="flex shrink-0 gap-0.5">
                  <button
                    className="rounded p-0.5 hover:bg-muted"
                    onClick={() => startEdit(step.index)}
                    aria-label={t("step.edit")}
                    data-testid="ai-shell-step-edit"
                  >
                    <PencilIcon className="h-2.5 w-2.5" />
                  </button>
                  <button
                    className="rounded p-0.5 hover:bg-muted"
                    onClick={() => onSkip(step.index)}
                    aria-label={t("step.skip")}
                    data-testid="ai-shell-step-skip"
                  >
                    <SkipForwardIcon className="h-2.5 w-2.5" />
                  </button>
                </div>
              )}
              {/* Failed step — request advisory */}
              {step.status === "failed" && !executing && (
                <button
                  className="shrink-0 rounded p-0.5 hover:bg-muted"
                  onClick={() => onRequestAdvisory(step.index)}
                  aria-label={t("error.advisory")}
                  data-testid="ai-shell-step-advisory"
                >
                  <AlertTriangleIcon className="h-2.5 w-2.5 text-amber-500" />
                </button>
              )}
            </li>
          ))}
        </ol>
      )}

      {/* Error advisory */}
      {advisory && (
        <div
          className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 dark:border-amber-800 dark:bg-amber-950/30"
          data-testid="ai-shell-advisory"
        >
          <p className="text-[10px] font-medium text-amber-800 dark:text-amber-200">
            {t("advisory.title")}
          </p>
          <p className="mt-0.5 text-[10px] text-amber-700 dark:text-amber-300">
            {advisory.diagnosis}
          </p>
          {advisory.suggestedFix ? (
            <div className="mt-1">
              <span className="text-[9px] text-amber-600 dark:text-amber-400">
                {t("advisory.fix")}
              </span>
              <code className="ml-1 font-mono text-[10px]">{advisory.suggestedFix}</code>
              <Button
                size="sm"
                variant="outline"
                className="ml-2 h-5 px-1.5 text-[9px]"
                onClick={onApplyFix}
                data-testid="ai-shell-apply-fix"
              >
                {t("advisory.applyFix")}
              </Button>
            </div>
          ) : (
            <p className="mt-1 text-[9px] text-amber-600 dark:text-amber-400">
              {t("advisory.noFix")}
            </p>
          )}
        </div>
      )}
      {advisoryLoading && (
        <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
          <LoaderIcon className="h-3 w-3 animate-spin" />
          {t("plan.generating")}
        </div>
      )}

      {/* Action buttons */}
      {plan.status !== "error" && plan.status !== "completed" && plan.status !== "cancelled" && (
        <div className="mt-2 flex items-center gap-1.5" data-testid="ai-shell-actions">
          {executing ? (
            <Button
              size="sm"
              variant="destructive"
              className="h-6 px-2 text-[10px]"
              onClick={onCancel}
              data-testid="ai-shell-stop"
            >
              {t("actions.stop")}
            </Button>
          ) : (
            <>
              {hasPendingSteps && (
                <>
                  <Button
                    size="sm"
                    variant="default"
                    className="h-6 px-2 text-[10px]"
                    onClick={onRunAll}
                    data-testid="ai-shell-run-all"
                  >
                    {t("actions.runAll")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[10px]"
                    onClick={onRunNext}
                    data-testid="ai-shell-step-by-step"
                  >
                    {t("actions.stepByStep")}
                  </Button>
                </>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[10px]"
                onClick={onCancel}
                data-testid="ai-shell-cancel"
              >
                {t("actions.cancel")}
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
