"use client"

/**
 * One open decision — body and actions — with no container of its own.
 *
 * Three surfaces ask the user the same questions and used to answer them three
 * different ways: the desktop tool dialog, the external-agent elicitation
 * dialog, and the remote session queue. Only the first two agreed on anything.
 * This is the single place that decides, for a given **kind** and **status**,
 * what may be shown and what may be pressed; the caller supplies the modal, the
 * card, or the drawer row around it.
 *
 * Two rules it exists to hold:
 *
 * 1. **A terminal decision offers no answer.** `interrupted`, `resolved` and
 *    `expired` all mean the runtime is no longer waiting, so Allow and Deny
 *    would be lies. Only Dismiss remains.
 * 2. **The allow direction can be wrapped, never bypassed.** Mobile puts the
 *    biometric guard on it. `confirmAllow` is the seam; deny is not wrapped,
 *    because refusing is the safe direction and making it harder than allowing
 *    inverts the incentive.
 *
 * `locked-computer-use` renders like a tool approval with the same actions,
 * because that is what it is — a permission decision the Host raised while the
 * screen was locked. It is **not produced yet**: host computer-use consent runs
 * through the automation ConsentBroker on a different plane, so nothing
 * currently constructs a decision with this kind. Kept because the HostState
 * vocabulary names it and the refusal path is live; pinned by a test.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@/components/ai-elements/confirmation"
import { ToolDecisionContent } from "./tool-decision-content"
import {
  ElicitationForm,
  initialElicitationValues,
  isElicitationComplete,
  type ElicitationValues,
} from "./elicitation-form"
import type { ApprovalDecision, PendingApproval } from "@cognia/agent-config-types"
import type { AcpElicitationRequest, AcpElicitationResponse } from "@/types/agent/external-agent"

/** Mirrors `HostStateDecisionKind` — kept structural so this file stays UI-only. */
export type PendingDecisionKind = "tool-approval" | "elicitation" | "locked-computer-use"

/** Mirrors `HostStateDecisionStatus`. */
export type PendingDecisionStatus =
  "pending" | "responding" | "resolved" | "expired" | "interrupted"

/** Statuses in which the runtime is no longer waiting for an answer. */
const TERMINAL_STATUSES: readonly PendingDecisionStatus[] = ["resolved", "expired", "interrupted"]

export type PendingDecision =
  | { kind: "tool-approval" | "locked-computer-use"; approval: PendingApproval }
  | { kind: "elicitation"; request: AcpElicitationRequest }

export interface PendingDecisionSurfaceProps {
  decision: PendingDecision
  status?: PendingDecisionStatus
  /**
   * `observe` renders the question but no way to answer it, and redacts the
   * arguments. A watcher without control cannot resolve the decision, and the
   * arguments are the part carrying file contents, commands and credentials.
   */
  mode?: "control" | "observe"
  onApprovalRespond?: (decision: ApprovalDecision) => void | Promise<void>
  onElicitationRespond?: (response: AcpElicitationResponse) => void | Promise<void>
  /** Clear a terminal decision. Required for the honest-notice card. */
  onDismiss?: () => void
  /** Abort the whole subagent run behind a subagent-origin approval. */
  onCancelRun?: (runId: string) => void
  /**
   * Wrap the allow direction — the mobile biometric guard. Receives the action;
   * must call it to let the approval through. Absent means no extra gate.
   */
  confirmAllow?: (run: () => Promise<void>) => Promise<void>
}

export function PendingDecisionSurface({
  decision,
  status = "pending",
  mode = "control",
  onApprovalRespond,
  onElicitationRespond,
  onDismiss,
  onCancelRun,
  confirmAllow,
}: PendingDecisionSurfaceProps) {
  const terminal = TERMINAL_STATUSES.includes(status)
  const actionable = mode === "control" && !terminal

  return (
    <div className="min-w-0 space-y-3" data-testid="pending-decision-surface" data-status={status}>
      {decision.kind === "elicitation" ? (
        <ElicitationDecision
          request={decision.request}
          actionable={actionable}
          responding={status === "responding"}
          onRespond={onElicitationRespond}
          onDismiss={terminal ? onDismiss : undefined}
        />
      ) : (
        <ApprovalDecisionBody
          approval={decision.approval}
          mode={mode}
          actionable={actionable}
          responding={status === "responding"}
          onRespond={onApprovalRespond}
          onDismiss={terminal ? onDismiss : undefined}
          onCancelRun={onCancelRun}
          confirmAllow={confirmAllow}
        />
      )}
    </div>
  )
}

function ApprovalDecisionBody({
  approval,
  mode,
  actionable,
  responding,
  onRespond,
  onDismiss,
  onCancelRun,
  confirmAllow,
}: {
  approval: PendingApproval
  mode: "control" | "observe"
  actionable: boolean
  responding: boolean
  onRespond?: (decision: ApprovalDecision) => void | Promise<void>
  onDismiss?: () => void
  onCancelRun?: (runId: string) => void
  confirmAllow?: (run: () => Promise<void>) => Promise<void>
}) {
  const t = useTranslations("chat.toolApproval")

  const respond = async (decision: ApprovalDecision) => {
    if (!onRespond) return
    // Deny is never wrapped: refusing is the safe direction, and putting a
    // biometric prompt in front of it would make the cautious answer the
    // expensive one.
    if (decision === "deny" || !confirmAllow) {
      await onRespond(decision)
      return
    }
    await confirmAllow(async () => {
      await onRespond(decision)
    })
  }

  return (
    <>
      <ToolDecisionContent approval={approval} mode={mode} />
      {onDismiss ? (
        <div className="flex justify-end">
          <Button variant="secondary" size="sm" onClick={onDismiss}>
            {t("dismiss")}
          </Button>
        </div>
      ) : actionable ? (
        <Confirmation
          approval={{ id: approval.requestId }}
          className="w-full border-0 p-0"
          state="approval-requested"
        >
          <ConfirmationRequest>
            <ConfirmationTitle className="sr-only">{t("actionsTitle")}</ConfirmationTitle>
            <ConfirmationActions className="w-full">
              {approval.origin === "subagent" && approval.subagentRunId && onCancelRun && (
                <ConfirmationAction
                  variant="ghost"
                  className="mr-auto text-destructive"
                  onClick={() => onCancelRun(approval.subagentRunId!)}
                >
                  {t("cancelRun")}
                </ConfirmationAction>
              )}
              {/* Deny only this tool call; the subagent run remains alive. */}
              <ConfirmationAction
                variant="ghost"
                disabled={responding}
                onClick={() => void respond("deny")}
                data-testid="decision-deny"
              >
                {t("deny")}
              </ConfirmationAction>
              <ConfirmationAction
                variant="secondary"
                disabled={responding}
                onClick={() => void respond("allow_always")}
                data-testid="decision-allow-always"
              >
                {t("allowAlways")}
              </ConfirmationAction>
              <ConfirmationAction
                disabled={responding}
                onClick={() => void respond("allow")}
                data-testid="decision-allow"
              >
                {t("allowOnce")}
              </ConfirmationAction>
            </ConfirmationActions>
          </ConfirmationRequest>
        </Confirmation>
      ) : null}
    </>
  )
}

/**
 * Holds the in-progress answer for exactly one request.
 *
 * The values live in state here rather than in the caller because every caller
 * would otherwise need the same slot; what matters is that the state is keyed
 * to the REQUEST. `useState`'s initializer runs once per mounted instance, so a
 * surface that swaps one decision for another at the same position — the remote
 * queue moving to the next open prompt — would otherwise re-use the previous
 * request's answers against the new request's schema. Resetting on a changed
 * `request.id` makes the identity explicit instead of depending on every caller
 * remembering to pass a `key`.
 */
function ElicitationDecision({
  request,
  actionable,
  responding,
  onRespond,
  onDismiss,
}: {
  request: AcpElicitationRequest
  actionable: boolean
  responding: boolean
  onRespond?: (response: AcpElicitationResponse) => void | Promise<void>
  onDismiss?: () => void
}) {
  const t = useTranslations("externalAgent.elicitation")
  const properties = request.requestedSchema?.properties ?? {}
  const required = request.requestedSchema?.required ?? []
  const [values, setValues] = useState<ElicitationValues>(() =>
    initialElicitationValues(properties)
  )
  // Render-phase reset (the documented React idiom for derived-from-props
  // state): no effect, so the new request never paints with the old answers.
  const [valuesForRequest, setValuesForRequest] = useState(request.id)
  if (valuesForRequest !== request.id) {
    setValuesForRequest(request.id)
    setValues(initialElicitationValues(properties))
  }
  const complete = isElicitationComplete(properties, required, values)

  const respond = (action: AcpElicitationResponse["action"]) =>
    void onRespond?.({
      requestId: request.id,
      action,
      content: action === "accept" ? values : undefined,
    })

  return (
    <>
      <p className="text-sm">{request.message}</p>
      <ElicitationForm
        request={request}
        values={values}
        onValuesChange={setValues}
        disabled={!actionable}
      />
      {onDismiss ? (
        <div className="flex justify-end">
          <Button variant="secondary" size="sm" onClick={onDismiss}>
            {t("dismiss")}
          </Button>
        </div>
      ) : actionable ? (
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={responding}
            onClick={() => respond("decline")}
          >
            {t("decline")}
          </Button>
          <Button
            size="sm"
            disabled={!complete || responding}
            onClick={() => respond("accept")}
            data-testid="decision-submit"
          >
            {t("submit")}
          </Button>
        </div>
      ) : null}
    </>
  )
}
