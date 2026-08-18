/**
 * PendingGatesStore — UI-side mirror of open HITL gates.
 *
 * Per ADR-0022 §3 HITL gates. TeamNotifier pushes critical notifications
 * carrying `openApproval: { scope, id }` payloads here; the team workspace
 * page mounts a `<GateModalsHost>` that renders one `<ApprovalGateDialog>`
 * per pending entry.
 *
 * Persistence: gates survive a reload, but the underlying approval-bus
 * waiter does NOT — so rehydration marks every restored gate `interrupted`.
 * An interrupted gate renders a Dismiss-only stale card (never live
 * Approve/Reject buttons that would resolve into the void). When the same
 * gate re-fires after reconnect, `open()` replaces the interrupted entry
 * with the fresh live one so it becomes answerable again.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { persistLocalStorage } from "@/stores/persist-storage"
import type { ApprovalKey } from "@/lib/runtime/approval-bus"

export type PendingGateType =
  "budget" | "deadlock" | "plan" | "teammate_fix" | "replan" | "capability_audit"

export type PendingGateStatus = "open" | "interrupted"

export interface PendingGate {
  key: ApprovalKey
  gateType: PendingGateType
  title: string
  body?: string
  runId: string
  teamId: string
  taskId?: string
  openedAt: number
  /** "open" = live (answerable). "interrupted" = restored from persistence
   * after the approval-bus waiter died with the page — Dismiss only. */
  status: PendingGateStatus
}

interface PendingGatesState {
  gates: PendingGate[]
  open(gate: Omit<PendingGate, "openedAt" | "status">): void
  close(key: ApprovalKey): void
  clearForRun(runId: string): void
}

export const usePendingGatesStore = create<PendingGatesState>()(
  persist(
    (set) => ({
      gates: [],
      open: (gate) =>
        set((s) => {
          const existing = s.gates.find(
            (g) => g.key.scope === gate.key.scope && g.key.id === gate.key.id
          )
          if (existing && existing.status === "open") return s
          const fresh: PendingGate = { ...gate, openedAt: Date.now(), status: "open" }
          if (existing) {
            // A re-fired gate replaces its interrupted ghost — answerable again.
            return {
              gates: s.gates.map((g) =>
                g.key.scope === gate.key.scope && g.key.id === gate.key.id ? fresh : g
              ),
            }
          }
          return { gates: [...s.gates, fresh] }
        }),
      close: (key) =>
        set((s) => ({
          gates: s.gates.filter((g) => !(g.key.scope === key.scope && g.key.id === key.id)),
        })),
      clearForRun: (runId) => set((s) => ({ gates: s.gates.filter((g) => g.runId !== runId) })),
    }),
    {
      name: "cognia-pending-gates",
      storage: persistLocalStorage(),
      version: 1,
      partialize: (s) => ({ gates: s.gates }),
      // The approval-bus waiter died with the previous page: every restored
      // gate is unanswerable and must render as interrupted, not live.
      onRehydrateStorage: () => (state) => {
        if (!state) return
        state.gates = state.gates.map((g) =>
          g.status === "interrupted" ? g : { ...g, status: "interrupted" as const }
        )
      },
      // Legacy rows (pre-persist v1) lack `status`; stamp them interrupted.
      migrate: (persisted) => {
        const p = persisted as { gates?: Array<Partial<PendingGate>> } | undefined
        return {
          gates: (p?.gates ?? []).map((g) => ({ ...g, status: "interrupted" as const })),
        } as Pick<PendingGatesState, "gates">
      },
    }
  )
)

/**
 * Map approval-bus scope strings to gate-modal variants.
 * Centralized here so the notifier and the modal host agree.
 */
export function gateTypeFromScope(scope: string): PendingGateType {
  switch (scope) {
    case "agent-team-budget":
    // The USD cost ceiling opens the same modal variant as the team's token
    // budget — same question, different unit.
    case "cost-budget":
      return "budget"
    case "agent-team-deadlock":
      return "deadlock"
    case "agent-team-teammate-fix":
      return "teammate_fix"
    case "agent-team-replan":
      return "replan"
    case "agent-team-capability-audit":
      return "capability_audit"
    case "agent-team":
    default:
      return "plan"
  }
}
