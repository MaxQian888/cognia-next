"use client"

/**
 * Hand-author a plan (`PlanSource: "manual"`) — the UI half of the manual plan
 * source that ADR-0045 specified but never shipped a producer for. (`/plan new
 * <title> | <step> | …` is the same producer from the composer.)
 *
 * Deliberately a plain title + one-step-per-line editor rather than a second
 * copy of the interactive HTML editor: a created plan lands `awaiting_approval`,
 * so the very next thing the user sees is {@link PlanApprovalCard} — which
 * already hosts the drag-reorder interactive editor. Authoring here and
 * refining there keeps one rich editor in the codebase, at the step where it
 * belongs.
 *
 * The lines are the titles; the "Step types" section below them is where a
 * step stops being a plain `agent_turn`. Every `PlanStepKind` the executor
 * implements (`lib/agent/plan/step-dispatch.ts`) is authorable here — before
 * this, delegation / tool / sub-workflow / approval-gate steps existed in the
 * executor and the type model but could only be produced by a workflow node,
 * so the richer half of the plan IR was unreachable from the product.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { getPlanRuntime } from "@/lib/agent/plan/runtime"
import { loadPlanConfigDefaults } from "@/lib/agent/plan/plan-settings"
import { linearAgentTurnSteps } from "@/lib/agent/plan/steps"
import { validatePlanStepParams } from "@/lib/agent/plan/step-params"
import type { CreatePlanStepInput, PlanStepKind } from "@/types/agent/plan"

/** Max characters kept from a title / step line (matches the other producers). */
const MAX_TITLE_LEN = 200
const MAX_PLAN_TITLE_LEN = 120

/** Every kind the dispatcher implements, in authoring order. */
export const COMPOSER_STEP_KINDS: readonly PlanStepKind[] = [
  "agent_turn",
  "teammate_dispatch",
  "tool_call",
  "mcp_tool_call",
  "sub_workflow",
  "approval_gate",
  "editor_review",
]

/** Free-text draft of one step's kind-specific params (validated on submit). */
export interface StepKindDraft {
  kind: PlanStepKind
  prompt?: string
  teamId?: string
  teammateId?: string
  toolName?: string
  toolInput?: string
  serverId?: string
  workflowId?: string
  /** `editor_review` — the file under review and its proposed contents. */
  path?: string
  content?: string
  title?: string
}

export const DEFAULT_STEP_DRAFT: StepKindDraft = { kind: "agent_turn" }

/**
 * Turn one draft into the persisted `params` union, or report why it can't be.
 *
 * The dialog's own job is text → object (JSON parsing of the tool-input box);
 * whether the resulting object is *runnable* is decided by the shared
 * `validatePlanStepParams`, which the agent-tool capture uses too — so a step
 * the composer accepts and a step the model authors are held to one standard.
 *
 * Returns `{ params }` on success (with `params: undefined` for a bare
 * agent_turn), `{ error }` otherwise.
 */
export function buildStepParams(
  draft: StepKindDraft
): { params?: CreatePlanStepInput["params"] } | { error: "missing" | "json" } {
  const input = parseJsonObject(draft.toolInput)
  if (input === "invalid") return { error: "json" }
  return validatePlanStepParams(draft.kind, {
    prompt: draft.prompt,
    spawnPrompt: draft.prompt,
    teamId: draft.teamId,
    teammateId: draft.teammateId,
    toolName: draft.toolName,
    serverId: draft.serverId,
    workflowId: draft.workflowId,
    path: draft.path,
    // Passed through even when blank: `validatePlanStepParams` treats an empty
    // string as a real proposal ("empty this file") and only a non-string as a
    // validation failure, so coercing undefined→"" here would turn "the author
    // forgot the content box" into a silent request to blank the file.
    content: draft.content,
    title: draft.title,
    input,
  })
}

/** `{}` for blank input, the parsed object, or the `"invalid"` sentinel. */
function parseJsonObject(raw: string | undefined): Record<string, unknown> | "invalid" {
  const text = raw?.trim()
  if (!text) return {}
  try {
    const value = JSON.parse(text) as unknown
    if (!value || typeof value !== "object" || Array.isArray(value)) return "invalid"
    return value as Record<string, unknown>
  } catch {
    return "invalid"
  }
}

export interface PlanComposerDialogProps {
  sessionId: string
  characterId?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Fired with the new plan id after a successful create (tests / callers). */
  onCreated?: (planId: string) => void
}

/** Split the textarea into ordered, non-empty step titles. */
export function parseStepLines(raw: string): string[] {
  return (
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      // Strip a leading list marker so pasted markdown works. `\s+|$` matters:
      // a bare "- " line trims to "-", which must drop out, not become a step.
      .map((line) => line.replace(/^(?:[-*]|\d+[.)])(?:\s+|$)/, "").trim())
      .filter(Boolean)
      .map((line) => line.slice(0, MAX_TITLE_LEN))
  )
}

export function PlanComposerDialog({
  sessionId,
  characterId,
  open,
  onOpenChange,
  onCreated,
}: PlanComposerDialogProps) {
  const t = useTranslations("plan.composer")
  const [title, setTitle] = useState("")
  const [stepsText, setStepsText] = useState("")
  const [busy, setBusy] = useState(false)
  // Kind drafts are positional: index i belongs to the i-th parsed line. A line
  // edit therefore keeps the kinds attached to positions, which is what a user
  // rewording step 2 expects; missing entries fall back to a plain agent turn.
  const [drafts, setDrafts] = useState<StepKindDraft[]>([])

  const steps = parseStepLines(stepsText)
  const draftAt = (i: number): StepKindDraft => drafts[i] ?? DEFAULT_STEP_DRAFT
  const patchDraft = (i: number, patch: Partial<StepKindDraft>) =>
    setDrafts((prev) => {
      const next = [...prev]
      while (next.length <= i) next.push({ ...DEFAULT_STEP_DRAFT })
      next[i] = { ...next[i], ...patch }
      return next
    })

  // Build once and reuse for both the submit guard and the create call, so the
  // button can never be enabled for a payload the builder rejects.
  const built = steps.map((_, i) => buildStepParams(draftAt(i)))
  const firstInvalid = built.findIndex((b) => "error" in b)
  const invalidStep =
    firstInvalid === -1 ? null : { index: firstInvalid + 1, ...built[firstInvalid] }
  const canSubmit = title.trim().length > 0 && steps.length > 0 && !busy && firstInvalid === -1
  const hasTypedStep = drafts.some((d) => d.kind !== "agent_turn")

  const reset = () => {
    setTitle("")
    setStepsText("")
    setDrafts([])
  }

  const handleOpenChange = (next: boolean) => {
    if (!next) reset()
    onOpenChange(next)
  }

  const handleCreate = async () => {
    if (!canSubmit) return
    setBusy(true)
    try {
      // The chain (titles + linear deps) stays shared with every other
      // producer; only the per-step kind/params overlay is composer-specific.
      const stepInputs: CreatePlanStepInput[] = linearAgentTurnSteps(steps).map((step, i) => {
        const draft = draftAt(i)
        const result = built[i]
        if ("error" in result) return step
        return {
          ...step,
          kind: draft.kind,
          ...(result.params ? { params: result.params } : {}),
        }
      })
      const defaults = await loadPlanConfigDefaults()
      const plan = await getPlanRuntime().createPlan({
        sessionId,
        ...(characterId ? { characterId } : {}),
        title: title.trim().slice(0, MAX_PLAN_TITLE_LEN),
        source: "manual",
        executionMode: "auto",
        steps: stepInputs,
        ...(defaults ? { config: defaults } : {}),
      })
      onCreated?.(plan.id)
      reset()
      onOpenChange(false)
    } catch {
      toast.error(t("createFailed"))
      setBusy(false)
      return
    }
    setBusy(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="plan-composer-dialog">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="plan-composer-title">{t("titleLabel")}</Label>
            <Input
              id="plan-composer-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("titlePlaceholder")}
              maxLength={MAX_PLAN_TITLE_LEN}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="plan-composer-steps">{t("stepsLabel")}</Label>
            <Textarea
              id="plan-composer-steps"
              value={stepsText}
              onChange={(e) => setStepsText(e.target.value)}
              placeholder={t("stepsPlaceholder")}
              rows={8}
              className="font-mono text-xs"
            />
            <p className="text-muted-foreground text-[11px]">
              {t("stepCount", { count: steps.length })}
            </p>
          </div>
          {steps.length > 0 && (
            <details
              className="rounded-md border px-2 py-1.5"
              open={hasTypedStep}
              data-testid="plan-composer-kinds"
            >
              <summary className="cursor-pointer text-xs font-medium">
                {t("advancedToggle")}
              </summary>
              <p className="text-muted-foreground pt-1 text-[11px]">{t("advancedHint")}</p>
              <div className="max-h-56 space-y-2 overflow-y-auto overscroll-contain pt-2">
                {steps.map((stepTitle, i) => (
                  <StepKindRow
                    key={i}
                    index={i}
                    title={stepTitle}
                    draft={draftAt(i)}
                    onPatch={(patch) => patchDraft(i, patch)}
                  />
                ))}
              </div>
            </details>
          )}
          {invalidStep && "error" in invalidStep && (
            <p className="text-destructive text-[11px]" data-testid="plan-composer-invalid">
              {invalidStep.error === "json"
                ? t("invalidJson", { index: invalidStep.index })
                : t("invalidStep", { index: invalidStep.index })}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button onClick={handleCreate} disabled={!canSubmit} data-testid="plan-composer-create">
            {t("create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Per-kind field set for one step row. Presentation only — the parent owns state. */
function StepKindRow({
  index,
  title,
  draft,
  onPatch,
}: {
  index: number
  title: string
  draft: StepKindDraft
  onPatch: (patch: Partial<StepKindDraft>) => void
}) {
  const t = useTranslations("plan.composer")
  // Derived from the draft rather than restated: the two lists drifted the
  // moment `editor_review` added fields, and a hardcoded union fails at the
  // call site instead of where the field was actually forgotten.
  const field = (key: Exclude<keyof StepKindDraft, "kind">) => (
    <div className="space-y-1" key={key}>
      <Label htmlFor={`plan-step-${index}-${key}`} className="text-[11px]">
        {t(`field.${key}`)}
      </Label>
      <Input
        id={`plan-step-${index}-${key}`}
        className="h-7 text-xs"
        value={draft[key] ?? ""}
        onChange={(e) => onPatch({ [key]: e.target.value })}
        data-testid={`plan-step-${index}-${key}`}
      />
    </div>
  )

  const fields: React.ReactNode[] = []
  switch (draft.kind) {
    case "agent_turn":
    case "approval_gate":
      fields.push(field("prompt"))
      break
    case "teammate_dispatch":
      fields.push(field("teamId"), field("teammateId"), field("prompt"))
      break
    case "tool_call":
      fields.push(field("toolName"), field("toolInput"))
      break
    case "mcp_tool_call":
      fields.push(field("serverId"), field("toolName"), field("toolInput"))
      break
    case "sub_workflow":
      fields.push(field("workflowId"))
      break
    case "editor_review":
      fields.push(field("path"), field("content"), field("title"), field("prompt"))
      break
  }

  return (
    <div className="space-y-1.5 rounded-md bg-muted/40 p-2" data-testid={`plan-step-row-${index}`}>
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground shrink-0 text-[11px]">{index + 1}.</span>
        <span className="min-w-0 flex-1 truncate text-xs">{title}</span>
        <Select
          value={draft.kind}
          onValueChange={(value) => onPatch({ kind: value as PlanStepKind })}
        >
          <SelectTrigger
            size="sm"
            className="h-7 w-[9.5rem] text-xs"
            aria-label={t("kindLabel")}
            data-testid={`plan-step-${index}-kind`}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {COMPOSER_STEP_KINDS.map((kind) => (
              <SelectItem key={kind} value={kind} className="text-xs">
                {t(`kind.${kind}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {fields.length > 0 && <div className="grid gap-1.5 pl-5 sm:grid-cols-2">{fields}</div>}
    </div>
  )
}
