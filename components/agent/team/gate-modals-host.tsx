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
import { decidePendingGate } from "@/lib/ai/agent/team/gates/decide-pending-gate"
import { usePendingGatesStore, type PendingGate } from "@/stores/agent/pending-gates-store"
import { ApprovalGateDialog } from "./approval-gate-dialog"
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
 * One mounted dialog bound to a single gate.
 *
 * This dialog is mounted at the app root so a gate is answerable from
 * whatever surface the user is on (ADR-0045); the island overlay answers the
 * same gates. Both settle through `decidePendingGate`, which resolves the
 * waiter, removes the entry and writes the decision back into the
 * conversation the run belongs to, so no surface can answer one without the
 * other two happening.
 */
function GateModalItem({ gate }: { gate: PendingGate }): React.ReactElement {
  const t = useTranslations("agentTeam.approvalGate")

  const approveAndClose = (payload?: unknown): void => {
    decidePendingGate(gate, { outcome: "approve", payload })
  }
  const rejectAndClose = (feedback?: string): void => {
    decidePendingGate(gate, { outcome: "reject", feedback })
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
                // A stale gate is dismissed, not answered — the waiter died
                // with the previous page. Worth recording precisely because
                // it means the run got no decision from this dialog.
                decidePendingGate(gate, { outcome: "dismiss" })
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
