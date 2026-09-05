"use client"

/**
 * The decision form for a pending Squad review (ADR-0169).
 *
 * One form per review kind, rendered from the interrupt's `reviewKind` and
 * its structured `subject`, never from runtime-authored text. What it submits
 * is the typed `SquadReviewDecision` the control gate validates, so a budget
 * amount cannot reach a deadlock gate and a legacy run cannot be asked to
 * retry.
 *
 * Free text (plan feedback) is the only unstructured field. It travels on the
 * control command, is PII-redacted by the gate before it is stored, and never
 * enters the run journal.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Textarea } from "@/components/ui/textarea"
import { isWellFormedSquadReviewDecision } from "@/lib/execution/squad-review-decision"
import type {
  ExecutionRunInterrupt,
  SquadReviewDecision,
  SquadReviewKind,
  TeamRecoveryChoice,
} from "@/types/execution/run"

export interface SquadReviewFormProps {
  interrupt: Pick<ExecutionRunInterrupt, "id" | "reviewKind" | "subject" | "expiresAt">
  busy?: boolean
  onDecide: (action: "approve" | "deny", decision: SquadReviewDecision | undefined) => void
}

const RECOVERY_CHOICES: readonly TeamRecoveryChoice[] = [
  "retry_same_host",
  "retry_host",
  "restart_run",
  "terminate",
]

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []
}

/** Which review kinds this form can render. Exported so the pane can gate on it. */
export function isRenderableSquadReview(
  interrupt: Pick<ExecutionRunInterrupt, "reviewKind">
): interrupt is Pick<ExecutionRunInterrupt, "reviewKind"> & { reviewKind: SquadReviewKind } {
  return interrupt.reviewKind !== undefined
}

export function SquadReviewForm({ interrupt, busy = false, onDecide }: SquadReviewFormProps) {
  const t = useTranslations("agentRuns.review")
  const kind = interrupt.reviewKind
  const subject = (interrupt.subject ?? {}) as Record<string, unknown>

  const [feedback, setFeedback] = useState("")
  const [extraTokens, setExtraTokens] = useState("50000")
  const [teammateIds, setTeammateIds] = useState<string[]>([])
  const [resetAll, setResetAll] = useState(false)
  const [repair, setRepair] = useState<"rejoin" | "skip">("rejoin")
  const [choice, setChoice] = useState<TeamRecoveryChoice | undefined>(undefined)
  const [hostRef, setHostRef] = useState("")

  if (!kind) return null

  const decision = (): SquadReviewDecision | undefined => {
    switch (kind) {
      case "plan":
        return feedback.trim() ? { kind, feedback: feedback.trim() } : { kind }
      case "capability_audit":
        return { kind }
      case "budget_extension":
        return { kind, extraTokens: Number.parseInt(extraTokens, 10) }
      case "deadlock":
        return resetAll ? { kind, resetAll: true } : { kind, teammateIds }
      case "teammate_repair":
        return { kind, action: repair }
      case "replan":
        return { kind }
      case "team_recovery":
        return choice
          ? { kind, choice, ...(choice === "retry_host" ? { hostRef: hostRef.trim() } : {}) }
          : undefined
    }
  }
  const approveDecision = decision()
  const canApprove =
    approveDecision !== undefined && isWellFormedSquadReviewDecision(approveDecision)
  const offeredChoices = stringList(subject.choices) as TeamRecoveryChoice[]
  const choices = RECOVERY_CHOICES.filter(
    (c) => offeredChoices.length === 0 || offeredChoices.includes(c)
  )
  const deadlockTeammates = stringList(subject.teammateIds)
  const missingCapabilities = stringList(subject.missingCapabilities)

  return (
    <form
      className="flex flex-col gap-3 rounded-md border p-3 text-sm"
      data-testid="squad-review-form"
      data-review-kind={kind}
      onSubmit={(event) => {
        event.preventDefault()
        if (canApprove) onDecide("approve", approveDecision)
      }}
    >
      <div>
        <p className="font-medium">{t(`kinds.${kind}.title`)}</p>
        <p className="text-xs text-muted-foreground">{t(`kinds.${kind}.description`)}</p>
      </div>

      {kind === "plan" && (
        <Textarea
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
          placeholder={t("plan.feedbackPlaceholder")}
          aria-label={t("plan.feedbackLabel")}
          rows={3}
        />
      )}

      {kind === "capability_audit" && missingCapabilities.length > 0 && (
        <ul className="list-disc pl-5 text-xs" aria-label={t("capabilityAudit.missingLabel")}>
          {missingCapabilities.map((id) => (
            <li key={id} className="font-mono">
              {id}
            </li>
          ))}
        </ul>
      )}

      {kind === "budget_extension" && (
        <div className="flex items-center gap-2">
          <Label htmlFor={`${interrupt.id}-tokens`} className="text-xs">
            {t("budget.extraTokensLabel")}
          </Label>
          <Input
            id={`${interrupt.id}-tokens`}
            type="number"
            min={1}
            inputMode="numeric"
            value={extraTokens}
            onChange={(event) => setExtraTokens(event.target.value)}
            className="h-8 w-32 text-sm"
          />
        </div>
      )}

      {kind === "deadlock" && (
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-xs">
            <Checkbox
              checked={resetAll}
              onCheckedChange={(checked) => setResetAll(checked === true)}
              aria-label={t("deadlock.resetAll")}
            />
            {t("deadlock.resetAll")}
          </label>
          {!resetAll && deadlockTeammates.length > 0 && (
            <div className="flex flex-col gap-1 pl-1" role="group" aria-label={t("deadlock.pick")}>
              {deadlockTeammates.map((id) => (
                <label key={id} className="flex items-center gap-2 text-xs">
                  <Checkbox
                    checked={teammateIds.includes(id)}
                    onCheckedChange={(checked) =>
                      setTeammateIds((current) =>
                        checked === true
                          ? [...current, id]
                          : current.filter((entry) => entry !== id)
                      )
                    }
                    aria-label={id}
                  />
                  <span className="font-mono">{id}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      {kind === "teammate_repair" && (
        <RadioGroup
          value={repair}
          onValueChange={(value) => setRepair(value === "skip" ? "skip" : "rejoin")}
          aria-label={t("teammateRepair.label")}
          className="gap-1"
        >
          {(["rejoin", "skip"] as const).map((action) => (
            <label key={action} className="flex items-center gap-2 text-xs">
              <RadioGroupItem value={action} aria-label={t(`teammateRepair.${action}`)} />
              {t(`teammateRepair.${action}`)}
            </label>
          ))}
        </RadioGroup>
      )}

      {kind === "team_recovery" && (
        <div className="flex flex-col gap-2">
          {typeof subject.reason === "string" && (
            <p className="text-xs text-muted-foreground">
              {t("recovery.reason", { reason: t(`recovery.reasons.${subject.reason}`) })}
            </p>
          )}
          <RadioGroup
            value={choice ?? ""}
            onValueChange={(value) => setChoice(value as TeamRecoveryChoice)}
            aria-label={t("recovery.label")}
            className="gap-1"
          >
            {choices.map((c) => (
              <label key={c} className="flex items-center gap-2 text-xs">
                <RadioGroupItem value={c} aria-label={t(`recovery.choices.${c}`)} />
                {t(`recovery.choices.${c}`)}
              </label>
            ))}
          </RadioGroup>
          {choice === "retry_host" && (
            <Input
              value={hostRef}
              onChange={(event) => setHostRef(event.target.value)}
              placeholder={t("recovery.hostRefPlaceholder")}
              aria-label={t("recovery.hostRefPlaceholder")}
              className="h-8 text-sm"
            />
          )}
        </div>
      )}

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || !canApprove}>
          {t(`kinds.${kind}.approve`)}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={busy}
          onClick={() =>
            onDecide(
              "deny",
              kind === "plan" && feedback.trim() ? { kind, feedback: feedback.trim() } : undefined
            )
          }
        >
          {t(`kinds.${kind}.deny`)}
        </Button>
      </div>
    </form>
  )
}
