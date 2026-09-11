"use client"

/**
 * GateModalsHost — the consumer for HITL approval gates (ADR-0022 §HITL gates).
 *
 * Subscribes to `usePendingGatesStore` and renders one <ApprovalGateDialog>
 * per open cost-budget or AgentPlan step gate. Squad gates moved to durable
 * ExecutionRunInterrupt records in ADR-0169 and do not use this store.
 *
 * Mounted EXACTLY ONCE, at the app root (`app/layout.tsx`), for every shell —
 * desktop and mobile alike. A gate can open while the user is on any surface,
 * so the host cannot live on the team workspace; and because the root mount is
 * unconditional, no surface may mount a second copy. Two hosts render two
 * stacked Radix dialogs per gate whose focus traps fight each other, and the
 * loser is invisible but still trapping.
 *
 * Every resolution path — approve, reject, or dismiss — resolves the underlying
 * approval-bus waiter AND removes the store entry. Dismissing the dialog without
 * an explicit decision routes through `reject()` so the blocked run always
 * unblocks rather than stranding the waiter.
 */

import { useTranslations } from "next-intl"
import { usePendingGatesStore, type PendingGate } from "@/stores/agent/pending-gates-store"
import { ApprovalGateDialog } from "./approval-gate-dialog"
import { useApprovalGate } from "./use-approval-gate"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

export function GateModalsHost(): React.ReactElement | null {
  const gates = usePendingGatesStore((s) => s.gates)
  if (gates.length === 0) return null
  return (
    <>
      {gates.map((gate) => (
        <GateModalItem key={`${gate.key.scope}:${gate.key.id}`} gate={gate} />
      ))}
    </>
  )
}

/**
 * One mounted dialog bound to a single gate. Kept as its own component so
 * `useApprovalGate` (a hook) is called once per gate without violating the
 * rules-of-hooks inside the parent's `.map`.
 */
function GateModalItem({ gate }: { gate: PendingGate }): React.ReactElement {
  const { approve, reject } = useApprovalGate(gate.key.scope, gate.key.id)
  const close = usePendingGatesStore((s) => s.close)
  const t = useTranslations("agentTeam.approvalGate")

  // This dialog is mounted at the app root so a gate is answerable from
  // whatever surface the user is on (ADR-0045). The cost is that answering it
  // leaves nothing behind — the modal is gone and no surface can say what was
  // approved, or when. Write the decision back into the conversation the run
  // belongs to. Fire-and-forget and best-effort: the run is waiting on the
  // answer, and losing the answer would be far worse than losing the note.
  const recordAnswer = (decision: "approved" | "rejected" | "dismissed"): void => {
    if (!gate.runId) return
    void import("@/lib/ai/agent/team/record-gate-answer")
      .then(({ recordSquadGateAnswer }) =>
        recordSquadGateAnswer({
          runId: gate.runId,
          gateType: gate.gateType,
          decision,
          title: gate.title,
        })
      )
      .catch(() => undefined)
  }

  const approveAndClose = (payload?: unknown): void => {
    approve(payload)
    close(gate.key)
    recordAnswer("approved")
  }
  const rejectAndClose = (feedback?: string): void => {
    reject(feedback)
    close(gate.key)
    recordAnswer("rejected")
  }

  // Restored-from-persistence gate: the approval-bus waiter died with the
  // previous page, so Approve/Reject would resolve into the void. Render an
  // honest stale card whose only action is Dismiss (store removal only, no
  // bus resolution); a re-fired gate replaces this entry via `open()` and
  // becomes answerable again. Placed after every hook call (rules of hooks).
  if (gate.status === "interrupted") {
    return (
      <Dialog open>
        <DialogContent showCloseButton={false} data-testid="stale-gate-card">
          <DialogHeader>
            <DialogTitle>{gate.title}</DialogTitle>
            <DialogDescription>{t("interruptedNotice")}</DialogDescription>
          </DialogHeader>
          {gate.body && <p className="text-sm text-muted-foreground">{gate.body}</p>}
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => {
                close(gate.key)
                // A stale gate is dismissed, not answered — the waiter died
                // with the previous page. Worth recording precisely because
                // it means the run got no decision from this dialog.
                recordAnswer("dismissed")
              }}
            >
              {t("dismissStale")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <ApprovalGateDialog
      open
      onClose={() => rejectAndClose()}
      gateType={gate.gateType}
      title={gate.title}
      scopeId={gate.key.id}
      body={gate.body}
      onApprove={approveAndClose}
      onReject={rejectAndClose}
    />
  )
}
