/**
 * PendingGatesStore — UI-side mirror of open HITL gates.
 *
 * Per ADR-0022 §3 HITL gates. TeamNotifier pushes critical notifications
 * carrying `openApproval: { scope, id }` payloads here; the team workspace
 * page mounts a `<GateModalsHost>` that renders one `<ApprovalGateDialog>`
 * per pending entry.
 *
 * The store is intentionally minimal — no persist middleware: pending gates
 * are run-scoped state that should not survive a refresh (the underlying
 * approval-bus waiter also drops on refresh; future v2 work could persist
 * both together).
 */

import { create } from "zustand"
import type { ApprovalKey } from "@/lib/runtime/approval-bus"

export type PendingGateType = "budget" | "deadlock" | "plan" | "teammate_fix" | "replan"

export interface PendingGate {
  key: ApprovalKey
  gateType: PendingGateType
  title: string
  body?: string
  runId: string
  teamId: string
  taskId?: string
  openedAt: number
}

interface PendingGatesState {
  gates: PendingGate[]
  open(gate: Omit<PendingGate, "openedAt">): void
  close(key: ApprovalKey): void
  clearForRun(runId: string): void
}

export const usePendingGatesStore = create<PendingGatesState>()((set) => ({
  gates: [],
  open: (gate) =>
    set((s) => {
      const existing = s.gates.find(
        (g) => g.key.scope === gate.key.scope && g.key.id === gate.key.id
      )
      if (existing) return s
      return { gates: [...s.gates, { ...gate, openedAt: Date.now() }] }
    }),
  close: (key) =>
    set((s) => ({
      gates: s.gates.filter((g) => !(g.key.scope === key.scope && g.key.id === key.id)),
    })),
  clearForRun: (runId) => set((s) => ({ gates: s.gates.filter((g) => g.runId !== runId) })),
}))

/**
 * Map approval-bus scope strings to gate-modal variants.
 * Centralized here so the notifier and the modal host agree.
 */
export function gateTypeFromScope(scope: string): PendingGateType {
  switch (scope) {
    case "agent-team-budget":
      return "budget"
    case "agent-team-deadlock":
      return "deadlock"
    case "agent-team-teammate-fix":
      return "teammate_fix"
    case "agent-team-replan":
      return "replan"
    case "agent-team":
    default:
      return "plan"
  }
}
