"use client"

/**
 * Inline plan approval card (ADR-0045 P5). A controlled component: it renders
 * a draft / awaiting-approval `AgentPlan` and surfaces the Claude-Code-style
 * approval decisions as callbacks, so the host wires them to the plan runtime
 * (and, for refine, an LlmClient). Mirrors the team `PlanApprovalPanel`.
 *
 * Decision model (Claude Code parity):
 *  - "Yes, auto-accept edits"   → onApprove("acceptEdits")
 *  - "Yes, review each edit"    → onApprove("default")
 *  - "Approve & run fully automated" (overflow, elevated) → onApprove("auto")
 *  - "No, keep planning"        → onKeepPlanning(feedback?) — non-destructive
 *  - "Discard plan" (overflow, destructive) → onDiscard(feedback?)
 *  - refine presets (overflow)  → onRefine(type, feedback?)
 *  - pencil toggle              → inline title/steps edit, saved via onEdit
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  CheckCircle2Icon,
  CircleIcon,
  ClockIcon,
  MinusCircleIcon,
  MoreHorizontalIcon,
  PencilIcon,
  XCircleIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { MarkdownRenderer } from "@/components/chat/markdown-renderer"
import { PlanHtmlView } from "./plan-html-view"
import type { PlanHtmlStyle } from "@/lib/agent/plan/plan-html"
import { permissionRiskMarker } from "@/lib/settings/permission-mode-meta"
import {
  computePlanCounts,
  type AgentPlan,
  type PlanRefinementType,
  type PlanStepStatus,
} from "@/types/agent/plan"

const REFINE_TYPES: PlanRefinementType[] = ["optimize", "simplify", "expand", "reorder"]

const REFINE_LABEL_KEY: Record<PlanRefinementType, string> = {
  optimize: "approval.refineOptimize",
  simplify: "approval.refineSimplify",
  expand: "approval.refineExpand",
  reorder: "approval.refineReorder",
  repair: "approval.refineRepair",
}

/**
 * The permission mode the session resumes in after an approval. Maps 1:1 onto
 * `PermissionMode` members — the host applies it directly, no translation.
 */
export type PlanResumeMode = "acceptEdits" | "default" | "auto"

/**
 * An inline plan edit. A plan captured with a full markdown body edits that
 * body (`planText`); a plan without one edits its step titles one per line
 * (`stepTitles`). The discriminant lets the host derive steps either way
 * without a fallback branch.
 */
export type PlanEditPatch =
  { title: string; planText: string } | { title: string; stepTitles: string[] }

export function stepStatusIcon(status: PlanStepStatus) {
  switch (status) {
    case "completed":
      return <CheckCircle2Icon className="size-3.5 shrink-0 text-green-600" />
    case "in_progress":
      return <ClockIcon className="size-3.5 shrink-0 animate-pulse text-yellow-600" />
    case "failed":
    case "blocked":
      return <XCircleIcon className="size-3.5 shrink-0 text-rose-600" />
    case "skipped":
      return <MinusCircleIcon className="size-3.5 shrink-0 text-muted-foreground" />
    default:
      return <CircleIcon className="size-3.5 shrink-0 text-muted-foreground" />
  }
}

export interface PlanApprovalCardProps {
  plan: AgentPlan
  /** Approve the plan; `mode` is the permission mode the session resumes in. */
  onApprove: (mode: PlanResumeMode) => void
  /**
   * "No, keep planning" — defer the decision, keep the plan as a draft, stay
   * in plan mode. Non-empty feedback should be sent to the model as a normal
   * follow-up turn by the host.
   */
  onKeepPlanning: (feedback?: string) => void
  /** Destructive discard (plan → cancelled). */
  onDiscard: (feedback?: string) => void
  /** When provided, refine presets are shown in the overflow menu. */
  onRefine?: (type: PlanRefinementType, feedback?: string) => void
  /**
   * When provided (and the plan is awaiting approval), a pencil toggle opens
   * an inline editor; saving hands the edit to the host, which persists it via
   * the runtime's `updatePlanDraft`. For an `exit_plan_mode` plan (one carrying
   * a full markdown body in `metadata.planText`) the editor edits the raw
   * markdown and the patch carries `planText`; otherwise it edits one step title
   * per line and the patch carries `stepTitles`.
   */
  onEdit?: (patch: PlanEditPatch) => void
  /**
   * Enhanced plan mode (opt-in via `planSettings.interactiveHtmlView`): render
   * the plan body as an interactive HTML editor (sandboxed iframe with drag
   * reorder / inline edit / add / remove steps) instead of the static list. A
   * header toggle lets the user fall back to the classic view. Requires
   * `onEdit` and an awaiting-approval plan; otherwise the classic body renders.
   */
  interactiveView?: boolean
  /** Built-in visual preset for the interactive body (`planSettings.interactiveHtmlStyle`). */
  interactiveStyle?: PlanHtmlStyle
  /** Disables all actions (e.g. while an approve/refine is in flight). */
  disabled?: boolean
}

export function PlanApprovalCard({
  plan,
  onApprove,
  onKeepPlanning,
  onDiscard,
  onRefine,
  onEdit,
  disabled,
}: PlanApprovalCardProps) {
  const t = useTranslations("plan")
  const [feedback, setFeedback] = useState("")
  const [editing, setEditing] = useState(false)
  const [editTitle, setEditTitle] = useState("")
  const [editSteps, setEditSteps] = useState("")
  const [editMarkdown, setEditMarkdown] = useState("")
  const steps = [...plan.steps].sort((a, b) => a.order - b.order)
  // The full markdown body an `exit_plan_mode` plan was captured from — the
  // step list is only a lossy projection of it, so when it's present we render
  // (and edit) the faithful markdown instead. (exit-plan-capture stamps it.)
  const planMeta = plan.metadata as { planText?: unknown } | undefined
  const planText = typeof planMeta?.planText === "string" ? planMeta.planText.trim() : ""
  const isMarkdownPlan = planText.length > 0
  const trimmed = () => feedback.trim() || undefined
  const { totalSteps, completedSteps } = computePlanCounts(plan.steps)
  const progressPct = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0
  const canEdit = Boolean(onEdit) && plan.status === "awaiting_approval"

  const openEditor = () => {
    setEditTitle(plan.title)
    setEditSteps(steps.map((s) => s.title).join("\n"))
    setEditMarkdown(planText)
    setEditing(true)
  }

  const saveEdit = () => {
    const title = editTitle.trim() || plan.title
    if (isMarkdownPlan) {
      // Editing the markdown body: only persist when it's non-empty so a stray
      // clear can't wipe the plan; the host re-derives steps from it.
      const md = editMarkdown.trim()
      if (md) onEdit?.({ title, planText: md })
    } else {
      const stepTitles = editSteps
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
      onEdit?.({ title, stepTitles })
    }
    setEditing(false)
  }

  // max-h (not h) + flex column: short plans stay compact; long plans cap at
  // 45vh with only the step list scrolling, so the action row and the composer
  // below the dock are never pushed off-screen.
  return (
    <Card className="flex max-h-[45vh] flex-col gap-3 p-3" data-testid="plan-approval-card">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold">{t("approval.title")}</span>
        <div className="flex items-center gap-1">
          {canEdit && (
            <Button
              size="icon"
              variant="ghost"
              className="size-6"
              disabled={disabled}
              onClick={() => (editing ? setEditing(false) : openEditor())}
              aria-label={t("approval.edit")}
              data-testid="plan-approval-edit"
            >
              <PencilIcon className="size-3.5" />
            </Button>
          )}
          <Badge variant="secondary">{t(`status.${plan.status}`)}</Badge>
        </div>
      </div>

      {editing ? (
        <div className="flex min-h-0 flex-col gap-2" data-testid="plan-approval-editor">
          <label className="text-xs text-muted-foreground" htmlFor="plan-edit-title">
            {t("approval.editTitleLabel")}
          </label>
          <Input
            id="plan-edit-title"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            className="h-8 text-sm"
            data-testid="plan-edit-title"
          />
          {isMarkdownPlan ? (
            <>
              <label className="text-xs text-muted-foreground" htmlFor="plan-edit-plan">
                {t("approval.editPlanLabel")}
              </label>
              <Textarea
                id="plan-edit-plan"
                rows={12}
                value={editMarkdown}
                onChange={(e) => setEditMarkdown(e.target.value)}
                placeholder={t("approval.editPlanHint")}
                className="min-h-0 flex-1 font-mono text-xs"
                data-testid="plan-edit-plan"
              />
            </>
          ) : (
            <>
              <label className="text-xs text-muted-foreground" htmlFor="plan-edit-steps">
                {t("approval.editStepsLabel")}
              </label>
              <Textarea
                id="plan-edit-steps"
                rows={8}
                value={editSteps}
                onChange={(e) => setEditSteps(e.target.value)}
                placeholder={t("approval.editStepsHint")}
                className="min-h-0 flex-1 text-xs"
                data-testid="plan-edit-steps"
              />
            </>
          )}
          <div className="flex items-center justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => setEditing(false)}
              data-testid="plan-edit-cancel"
            >
              {t("approval.editCancel")}
            </Button>
            <Button size="sm" disabled={disabled} onClick={saveEdit} data-testid="plan-edit-save">
              {t("approval.editSave")}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div>
            <div className="text-sm font-medium break-words">{plan.title}</div>
            <div className="text-xs text-muted-foreground">
              {t("approval.sourceLabel", { source: plan.source })}
            </div>
          </div>

          {totalSteps > 0 && (
            <div className="space-y-1" data-testid="plan-approval-progress">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{t("approval.progressLabel")}</span>
                <span className="tabular-nums">
                  {completedSteps}/{totalSteps}
                </span>
              </div>
              <div
                className="h-1.5 overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-valuenow={progressPct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={t("approval.progressLabel")}
              >
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>
          )}

          {showInteractive ? (
            // Enhanced plan mode: the interactive HTML editor (sandboxed
            // iframe) replaces the static body; edits flow through the same
            // onEdit channel as the classic pencil editor.
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              <PlanHtmlView
                plan={plan}
                onSave={(patch) => onEdit?.(patch)}
                styleVariant={interactiveStyle}
                disabled={disabled}
              />
            </div>
          ) : isMarkdownPlan ? (
            // Faithful plan body: render the captured markdown (headings, lists,
            // code, tables) instead of the lossy step-title projection, capped +
            // scrolling in its own container so the actions/composer stay put.
            // Native overflow (not Radix ScrollArea): the thumb stays grabbable
            // while text is selected, matching the transcript PlanCard.
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-md bg-muted/40">
              <div data-testid="plan-approval-body" className="p-2 text-sm">
                <MarkdownRenderer content={planText} />
              </div>
            </div>
          ) : steps.length > 0 ? (
            // Native overflow, not Radix ScrollArea: a persistent grabbable thumb
            // that keeps working while text is selected inside the transcript.
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-md bg-muted/40">
              <ul className="space-y-1 p-2" data-testid="plan-approval-steps">
                {steps.map((s) => (
                  <li key={s.id} className="flex items-start gap-2 text-xs" data-status={s.status}>
                    {stepStatusIcon(s.status)}
                    <span
                      className={cn(
                        "min-w-0 flex-1 break-words",
                        s.status === "completed" && "text-muted-foreground line-through"
                      )}
                    >
                      {s.title}
                    </span>
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      {s.kind}
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-xs italic text-muted-foreground">{t("approval.noSteps")}</p>
          )}

          <Textarea
            rows={2}
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder={t("approval.feedbackPlaceholder")}
            className="text-xs"
            data-testid="plan-approval-feedback"
          />

          <div className="flex flex-wrap items-center justify-end gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8"
                  disabled={disabled}
                  aria-label={t("approval.moreActions")}
                  data-testid="plan-approval-more"
                >
                  <MoreHorizontalIcon className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {/* Fully-automated run is an elevated-risk mode (outside the safe
                    cycle), so it lives here rather than as a primary button. */}
                <DropdownMenuItem
                  disabled={disabled}
                  onSelect={() => onApprove("auto")}
                  data-testid="plan-approval-approve-full-auto"
                >
                  {`${permissionRiskMarker("auto")} ${t("approval.approveFullAuto")}`.trim()}
                </DropdownMenuItem>
                {onRefine && (
                  <>
                    <DropdownMenuSeparator />
                    {REFINE_TYPES.map((rt) => (
                      <DropdownMenuItem
                        key={rt}
                        disabled={disabled}
                        onSelect={() => onRefine(rt, trimmed())}
                        data-testid={`plan-refine-${rt}`}
                      >
                        {t(REFINE_LABEL_KEY[rt])}
                      </DropdownMenuItem>
                    ))}
                  </>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  disabled={disabled}
                  onSelect={() => onDiscard(trimmed())}
                  data-testid="plan-approval-discard"
                >
                  {t("approval.discard")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => onKeepPlanning(trimmed())}
              data-testid="plan-approval-keep-planning"
            >
              {t("approval.keepPlanning")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => onApprove("default")}
              data-testid="plan-approval-approve-review"
            >
              {t("approval.approveReviewEach")}
            </Button>
            <Button
              size="sm"
              disabled={disabled}
              onClick={() => onApprove("acceptEdits")}
              data-testid="plan-approval-approve-auto"
            >
              {t("approval.approveAcceptEdits")}
            </Button>
          </div>
        </>
      )}
    </Card>
  )
}
