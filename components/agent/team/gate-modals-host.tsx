"use client"

/**
 * GateModalsHost — the consumer for HITL approval gates (ADR-0022 §HITL gates).
 *
 * Subscribes to `usePendingGatesStore` and renders one <ApprovalGateDialog>
 * per open gate. Without this host the budget / deadlock / teammate-fix gates
 * have a producer (`TeamNotifier.openGate`) but no UI, so a paused team run
 * (`concurrency.reduceTo(0)`) hangs forever with no release valve. Mount once
 * on the team workspace surface.
 *
 * Every resolution path — approve, reject, or dismiss — resolves the underlying
 * approval-bus waiter AND removes the store entry. Dismissing the dialog without
 * an explicit decision routes through `reject()` so the blocked run always
 * unblocks rather than stranding the waiter.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { usePendingGatesStore, type PendingGate } from "@/stores/agent/pending-gates-store"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
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

  // The deadlock gate fires when ALL teammates are unavailable, so every
  // teammate on the team is a valid reset candidate. Other gate types don't
  // use the list. Select the stable `teammates` record and derive the list in
  // a memo — mapping inside the selector would return fresh objects each render
  // and loop forever.
  const teammatesRecord = useAgentTeamStore((s) => s.teammates)
  const quarantinedTeammates = useMemo(
    () =>
      gate.gateType === "deadlock"
        ? Object.values(teammatesRecord)
            .filter((m) => m.teamId === gate.teamId)
            .map((m) => ({ id: m.id, name: m.name }))
        : undefined,
    [teammatesRecord, gate.gateType, gate.teamId]
  )

  const approveAndClose = (payload?: unknown): void => {
    approve(payload)
    close(gate.key)
  }
  const rejectAndClose = (feedback?: string): void => {
    reject(feedback)
    close(gate.key)
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
            <Button variant="secondary" onClick={() => close(gate.key)}>
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
      scopeId={gate.key.id}
      body={gate.body}
      onApprove={approveAndClose}
      onReject={rejectAndClose}
      quarantinedTeammates={quarantinedTeammates}
    />
  )
}
