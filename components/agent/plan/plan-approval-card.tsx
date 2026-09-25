"use client"

/**
 * Inline plan approval card (ADR-0045 P5). A controlled component: it renders
 * an awaiting-approval `AgentPlan` and surfaces the Claude-Code-style approval
 * decisions as callbacks; the host wires them to the plan runtime (and, for
 * refine, an LlmClient). Mirrors the team `PlanApprovalPanel`.
 *
 * Three bands, and only the middle one grows:
 *   header  status · provenance · step count, the title, and the view
 *           controls (interactive view, markdown source, open in the side
 *           panel, collapse)
 *   body    the plan document, capped at a share of the viewport so the
 *           decisions and the composer below always stay on screen; long
 *           plans read in full in the dock's Plan panel
 *   footer  feedback + decisions. The decisions stack in a narrow card —
 *           a container query, since a split pane is narrow on a wide screen
 *
 * Decision model (Claude Code parity):
 *  - "Yes, auto-accept edits"   → onApprove("acceptEdits")
 *  - "Yes, review each edit"    → onApprove("default")
 *  - "Approve & run fully automated" (overflow, elevated) → onApprove("auto")
 *  - "No, keep planning"        → onKeepPlanning(feedback?) — non-destructive
 *  - "Reject"                   → inline confirm with an optional reason, then
 *                                 onReject(reason?) — the terminal `rejected`
 *                                 status, not a disguised cancel
 *  - refine presets (overflow)  → onRefine(type, feedback?)
 *  - "Open in plan editor" (overflow) → onOpenEditor() — title + step types
 *
 * Step rows edit inline in the document itself (autosaved through `onEdit`);
 * a plan captured as markdown additionally offers its raw source for prose
 * edits.
 */

import { useId, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  ChevronDownIcon,
  CodeIcon,
  ListIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PanelRightOpenIcon,
  SparklesIcon,
  SquarePenIcon,
  WandSparklesIcon,
  XCircleIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { PlanDocument } from "./plan-document"
import { PlanHtmlView } from "./plan-html-view"
import type { PlanHtmlStyle } from "@/lib/agent/plan/plan-html"
import { splitPlanDocument } from "@/lib/agent/plan/plan-doc"
import { permissionRiskMarker } from "@/lib/settings/permission-mode-meta"
import type { AgentPlan, PlanEditPatch, PlanRefinementType } from "@/types/agent/plan"

const REFINE_TYPES: PlanRefinementType[] = ["optimize", "simplify", "expand", "reorder"]

const REFINE_LABEL_KEY: Record<PlanRefinementType, string> = {
  optimize: "approval.refineOptimize",
  simplify: "approval.refineSimplify",
  expand: "approval.refineExpand",
  reorder: "approval.refineReorder",
  repair: "approval.refineRepair",
}

/**
 * The body's height cap. A share of the viewport (not the card) because what
 * must stay visible — the decisions and the composer — is outside the body;
 * phones get a smaller share since their footer stacks.
 */
const BODY_MAX_H = "max-h-[34dvh] md:max-h-[min(42dvh,30rem)]"

/**
 * The permission mode the session resumes in after an approval. Maps 1:1 onto
 * `PermissionMode` members — the host applies it directly, no translation.
 */
export type PlanResumeMode = "acceptEdits" | "default" | "auto"

/**
 * An inline plan edit. A plan captured with a full markdown body edits that
 * body (`planText`); a plan without one edits its step titles (`stepTitles`).
 * The canonical definition lives in `types/agent/plan` — re-exported for the
 * card's existing consumers.
 */
export type { PlanEditPatch }

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
  /**
   * Reject the plan (terminal `rejected`), with the optional reason the user
   * typed in the confirm step. The card asks for confirmation first.
   */
  onReject: (reason?: string) => void
  /**
   * Open the plan editor ("Write a plan": title + one step per line + step
   * types) pre-filled with this plan. The host owns the dialog; omitted ⇒ no
   * overflow entry.
   */
  onOpenEditor?: () => void
  /** When provided, refine presets are shown in the overflow menu. */
  onRefine?: (type: PlanRefinementType, feedback?: string) => void
  /**
   * Persist an edit of an awaiting-approval plan: the document's inline step
   * rows autosave through it, and a markdown plan's source editor saves
   * through it. Its promise drives the document's save indicator, so a host
   * should reject when the write did not land.
   */
  onEdit?: (patch: PlanEditPatch) => void | Promise<void>
  /** Open this plan in the dock's Plan panel (full-height reading, history). */
  onOpenPanel?: () => void
  /**
   * Enhanced plan mode (opt-in via `planSettings.interactiveHtmlView`): render
   * the plan body as an interactive HTML editor (sandboxed iframe with drag
   * reorder / inline edit / add / remove steps) instead of the document. A
   * header toggle falls back to the document. Requires `onEdit` and an
   * awaiting-approval plan; otherwise the document renders.
   */
  interactiveView?: boolean
  /** Built-in visual preset for the interactive body (`planSettings.interactiveHtmlStyle`). */
  interactiveStyle?: PlanHtmlStyle
  /** Disables all actions (e.g. while an approve/refine is in flight). */
  disabled?: boolean
  /** A refinement is being generated: the header says so and the body dims. */
  refining?: boolean
}

export function PlanApprovalCard({
  plan,
  onApprove,
  onKeepPlanning,
  onReject,
  onOpenEditor,
  onRefine,
  onEdit,
  onOpenPanel,
  disabled,
  refining,
  interactiveView,
  interactiveStyle,
}: PlanApprovalCardProps) {
  const t = useTranslations("plan")
  const bodyId = useId()
  const [feedback, setFeedback] = useState("")
  const [collapsed, setCollapsed] = useState(false)
  // Enhanced view opt-out is per-card, not persisted: the setting turns the
  // interactive body on by default; this flips back to the document.
  const [classicView, setClassicView] = useState(false)
  // The markdown source editor: `null` = closed. `failed` keeps it open with
  // the text intact when the write did not land.
  const [source, setSource] = useState<{
    title: string
    markdown: string
    failed?: boolean
  } | null>(null)
  // Reject is terminal, so it takes a second, explicit step that also collects
  // the reason. `null` = not confirming.
  const [rejectReason, setRejectReason] = useState<string | null>(null)

  // The full markdown body an `exit_plan_mode` plan was captured from — the
  // step list is only a projection of it (exit-plan-capture stamps it).
  const planMeta = plan.metadata as { planText?: unknown } | undefined
  const planText = typeof planMeta?.planText === "string" ? planMeta.planText.trim() : ""
  const isMarkdownPlan = planText.length > 0
  // The count a reader sees: the document's steps section when it has one
  // (a Files checklist's bullets are in the projection, not in the steps).
  const stepCount =
    (isMarkdownPlan ? splitPlanDocument(planText).steps?.length : undefined) ?? plan.steps.length
  const trimmed = () => feedback.trim() || undefined
  const canEdit = Boolean(onEdit) && plan.status === "awaiting_approval"
  const editingSource = source !== null

  // The interactive HTML body edits the plan, so it shares canEdit's gate.
  const interactiveAvailable = Boolean(interactiveView) && canEdit
  const showInteractive = interactiveAvailable && !classicView && !editingSource

  /** Write an edit; `false` (with a toast) when the host rejected it. */
  const persist = async (patch: PlanEditPatch): Promise<boolean> => {
    try {
      await onEdit?.(patch)
      return true
    } catch {
      toast.error(t("composer.saveFailed"))
      return false
    }
  }

  const saveSource = async () => {
    if (!source) return
    // Only persist a non-empty body so a stray clear can't wipe the plan; the
    // host re-derives steps from it.
    const markdown = source.markdown.trim()
    if (markdown) {
      const saved = await persist({ title: source.title.trim() || plan.title, planText: markdown })
      if (!saved) {
        setSource({ ...source, failed: true })
        return
      }
    }
    setSource(null)
  }

  const iconButton = "size-7 text-muted-foreground hover:text-foreground"

  return (
    <Card
      role="region"
      aria-label={t("approval.title")}
      aria-busy={refining || undefined}
      className="@container/plan gap-0 overflow-hidden py-0"
      data-testid="plan-approval-card"
    >
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-start gap-2 px-3 pt-2.5 pb-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                plan.status === "awaiting_approval" ? "bg-amber-500" : "bg-muted-foreground/50"
              )}
              aria-hidden
            />
            <span className="shrink-0 font-medium text-foreground/80">
              {t(`status.${plan.status}`)}
            </span>
            <span aria-hidden>·</span>
            <span className="truncate" data-testid="plan-approval-source">
              {t(`approval.source.${plan.source}`)}
            </span>
            {stepCount > 0 && (
              <>
                <span aria-hidden>·</span>
                <span className="shrink-0 tabular-nums" data-testid="plan-approval-step-count">
                  {t("composer.stepCount", { count: stepCount })}
                </span>
              </>
            )}
            {refining && (
              <span
                className="inline-flex shrink-0 items-center gap-1 text-foreground/80 animate-in fade-in-0"
                data-testid="plan-approval-refining"
              >
                <Loader2Icon className="size-3 motion-safe:animate-spin" />
                {t("approval.refining")}
              </span>
            )}
          </div>
          <h3
            className="mt-0.5 line-clamp-2 text-sm leading-snug font-semibold break-words"
            title={plan.title}
            data-testid="plan-approval-title"
          >
            {plan.title}
          </h3>
        </div>
        <div className="-mt-0.5 -mr-1.5 flex shrink-0 items-center">
          {interactiveAvailable && (
            <Button
              size="icon"
              variant="ghost"
              className={iconButton}
              disabled={disabled || editingSource}
              onClick={() => setClassicView((v) => !v)}
              aria-label={
                classicView
                  ? t("approval.interactive.viewInteractive")
                  : t("approval.interactive.viewClassic")
              }
              title={
                classicView
                  ? t("approval.interactive.viewInteractive")
                  : t("approval.interactive.viewClassic")
              }
              data-testid="plan-approval-view-toggle"
            >
              {classicView ? (
                <SparklesIcon className="size-3.5" />
              ) : (
                <ListIcon className="size-3.5" />
              )}
            </Button>
          )}
          {canEdit && isMarkdownPlan && !showInteractive && (
            <Button
              size="icon"
              variant="ghost"
              className={cn(iconButton, editingSource && "bg-muted text-foreground")}
              disabled={disabled}
              aria-pressed={editingSource}
              onClick={() => {
                setCollapsed(false)
                setSource(editingSource ? null : { title: plan.title, markdown: planText })
              }}
              aria-label={t("approval.editSource")}
              title={t("approval.editSource")}
              data-testid="plan-approval-edit"
            >
              <CodeIcon className="size-3.5" />
            </Button>
          )}
          {onOpenPanel && (
            <Button
              size="icon"
              variant="ghost"
              className={iconButton}
              onClick={() => {
                // The panel now shows the document at full height; folding
                // the card's copy keeps one reading surface and the transcript
                // in view. The decisions stay right here.
                setCollapsed(true)
                onOpenPanel()
              }}
              aria-label={t("approval.openInPanel")}
              title={t("approval.openInPanel")}
              data-testid="plan-approval-open-panel"
            >
              <PanelRightOpenIcon className="size-3.5" />
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            className={iconButton}
            onClick={() => setCollapsed((v) => !v)}
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            aria-label={collapsed ? t("approval.expand") : t("approval.collapse")}
            title={collapsed ? t("approval.expand") : t("approval.collapse")}
            data-testid="plan-approval-collapse"
          >
            <ChevronDownIcon
              className={cn(
                "size-3.5 transition-transform duration-200 motion-reduce:transition-none",
                !collapsed && "rotate-180"
              )}
            />
          </Button>
        </div>
      </div>

      {/* ── Body ───────────────────────────────────────────────────────── */}
      {/* grid-rows 0fr↔1fr animates the collapse to the content's real
          height; `inert` takes the hidden rows out of the tab order. */}
      <div
        id={bodyId}
        inert={collapsed}
        className={cn(
          "grid bg-inherit transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
          collapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr]"
        )}
        data-testid="plan-approval-body"
        data-collapsed={collapsed ? "true" : undefined}
      >
        <div className="min-h-0 overflow-hidden bg-inherit">
          <div
            className={cn(
              "flex flex-col border-t border-border/60 bg-inherit transition-opacity duration-200",
              refining && "opacity-60"
            )}
          >
            {editingSource ? (
              <div className="flex flex-col gap-2 p-3" data-testid="plan-approval-editor">
                <label className="sr-only" htmlFor={`${bodyId}-title`}>
                  {t("approval.editTitleLabel")}
                </label>
                <Input
                  id={`${bodyId}-title`}
                  value={source.title}
                  onChange={(e) => setSource({ ...source, title: e.target.value })}
                  placeholder={t("approval.editTitleLabel")}
                  className="h-8 text-sm font-medium"
                  data-testid="plan-edit-title"
                />
                <label className="sr-only" htmlFor={`${bodyId}-md`}>
                  {t("approval.editPlanLabel")}
                </label>
                <Textarea
                  id={`${bodyId}-md`}
                  value={source.markdown}
                  onChange={(e) => setSource({ ...source, markdown: e.target.value })}
                  placeholder={t("approval.editPlanHint")}
                  // Same height as the document it replaces, so toggling the
                  // source view does not jump the layout.
                  className="field-sizing-fixed h-[34dvh] min-h-40 resize-none font-mono text-xs leading-relaxed md:h-[min(42dvh,30rem)] md:text-xs"
                  aria-invalid={source.failed || undefined}
                  data-testid="plan-edit-plan"
                />
                {source.failed && (
                  <p
                    className="text-xs text-destructive"
                    role="alert"
                    data-testid="plan-edit-failed"
                  >
                    {t("composer.saveFailed")}
                  </p>
                )}
              </div>
            ) : showInteractive ? (
              // Enhanced plan mode: the interactive HTML editor (sandboxed
              // iframe) replaces the document; edits flow through the same
              // onEdit channel.
              <div className={cn("overflow-y-auto overscroll-contain p-2", BODY_MAX_H)}>
                <PlanHtmlView
                  plan={plan}
                  onSave={(patch) => void persist(patch)}
                  styleVariant={interactiveStyle}
                  disabled={disabled}
                />
              </div>
            ) : (
              // The document: the captured markdown with the executable step
              // list embedded in place. Native overflow (not Radix ScrollArea):
              // a persistent grabbable thumb that keeps working while text is
              // selected.
              <PlanDocument
                plan={plan}
                editable={canEdit}
                onEdit={onEdit}
                className={cn("flex-none", BODY_MAX_H)}
              />
            )}
          </div>
        </div>
      </div>

      {/* ── Footer ─────────────────────────────────────────────────────── */}
      <div className="border-t border-border/60 px-3 py-2.5">
        {editingSource ? (
          <div className="flex items-center justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => setSource(null)}
              data-testid="plan-edit-cancel"
            >
              {t("approval.editCancel")}
            </Button>
            <Button
              size="sm"
              disabled={disabled}
              onClick={() => void saveSource()}
              data-testid="plan-edit-save"
            >
              {t("approval.editSave")}
            </Button>
          </div>
        ) : rejectReason !== null ? (
          <div
            className="space-y-2 animate-in fade-in-0 slide-in-from-bottom-1 duration-200"
            role="group"
            aria-label={t("approval.rejectConfirmTitle")}
            data-testid="plan-approval-reject-confirm"
          >
            <div className="flex items-start gap-2">
              <XCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
              <div className="min-w-0">
                <p className="text-sm font-medium">{t("approval.rejectConfirmTitle")}</p>
                <p className="text-xs text-muted-foreground">{t("approval.rejectConfirmBody")}</p>
              </div>
            </div>
            <label className="sr-only" htmlFor={`${bodyId}-reject`}>
              {t("approval.rejectReasonLabel")}
            </label>
            <Textarea
              id={`${bodyId}-reject`}
              autoFocus
              rows={1}
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder={t("approval.rejectReasonPlaceholder")}
              className="max-h-32 min-h-9 resize-none py-2 text-sm"
              data-testid="plan-approval-reject-reason"
            />
            <div className="flex items-center justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => setRejectReason(null)}
                data-testid="plan-approval-reject-back"
              >
                {t("approval.rejectBack")}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={disabled}
                onClick={() => onReject(rejectReason.trim() || undefined)}
                data-testid="plan-approval-reject-confirm-button"
              >
                {t("approval.rejectConfirm")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <Textarea
              rows={1}
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder={t("approval.feedbackPlaceholder")}
              aria-label={t("approval.feedbackLabel")}
              className="max-h-32 min-h-9 resize-none py-2 text-sm"
              data-testid="plan-approval-feedback"
            />
            {/* Narrow: the primary decision full-width, the two secondary ones
                side by side, the rarely-used actions last. Wide: one row, the
                primary decision rightmost. */}
            <div className="grid gap-2 @2xl/plan:flex @2xl/plan:items-center">
              <div className="order-last flex items-center gap-1 @2xl/plan:order-none @2xl/plan:mr-auto">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-8 text-muted-foreground"
                      disabled={disabled}
                      aria-label={t("approval.moreActions")}
                      data-testid="plan-approval-more"
                    >
                      <MoreHorizontalIcon className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-64">
                    {/* Fully-automated run is an elevated-risk mode (outside the
                        safe cycle), so it lives here rather than as a button. */}
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
                        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                          {feedback.trim()
                            ? t("approval.refineWithNote")
                            : t("approval.refineHeading")}
                        </DropdownMenuLabel>
                        {REFINE_TYPES.map((rt) => (
                          <DropdownMenuItem
                            key={rt}
                            disabled={disabled}
                            onSelect={() => onRefine(rt, trimmed())}
                            data-testid={`plan-refine-${rt}`}
                          >
                            <WandSparklesIcon className="text-muted-foreground" />
                            {t(REFINE_LABEL_KEY[rt])}
                          </DropdownMenuItem>
                        ))}
                      </>
                    )}
                    {onOpenEditor && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          disabled={disabled}
                          onSelect={onOpenEditor}
                          data-testid="plan-approval-open-editor"
                        >
                          <SquarePenIcon className="text-muted-foreground" />
                          {t("approval.openInEditor")}
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  disabled={disabled}
                  // The feedback already typed is the likeliest reason; it
                  // seeds the confirm step rather than being thrown away.
                  onClick={() => setRejectReason(feedback)}
                  data-testid="plan-approval-reject"
                >
                  <XCircleIcon className="size-3.5" />
                  {t("approval.reject")}
                </Button>
              </div>
              <Button
                size="sm"
                className="@2xl/plan:order-3"
                disabled={disabled}
                onClick={() => onApprove("acceptEdits")}
                data-testid="plan-approval-approve-auto"
              >
                {t("approval.approveAcceptEdits")}
              </Button>
              <div className="grid grid-cols-2 gap-2 @2xl/plan:contents">
                <Button
                  size="sm"
                  variant="outline"
                  className="@2xl/plan:order-2"
                  disabled={disabled}
                  onClick={() => onApprove("default")}
                  data-testid="plan-approval-approve-review"
                >
                  {t("approval.approveReviewEach")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="@2xl/plan:order-1"
                  disabled={disabled}
                  onClick={() => onKeepPlanning(trimmed())}
                  data-testid="plan-approval-keep-planning"
                >
                  {t("approval.keepPlanning")}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}
