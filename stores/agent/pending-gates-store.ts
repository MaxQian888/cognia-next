/**
 * PendingGatesStore: UI-side mirror of the open HITL gates that still ride the
 * in-memory approval bus.
 *
 * Two producers remain:
 *   • ADR-0045 plan gates: an `approval_gate` plan step
 *     (`lib/agent/plan/step-dispatch.ts`) registers itself here before it
 *     blocks on the approval bus. Session-scoped.
 *   • The USD cost ceiling (`lib/usage/cost-budget-runtime.ts`), which asks
 *     for one more request through the same modal.
 *
 * Squad gates are NOT here any more (ADR-0169). A Squad's plan, capability
 * audit, budget extension, deadlock, teammate repair, re-plan and recovery
 * decisions are durable `ExecutionRunInterrupt`s opened by
 * `lib/ai/agent/team/squad-review-gate.ts` and answered through the run
 * control plane, which is what lets a reload, a phone and an IM card all see
 * and settle the same question.
 *
 * `<GateModalsHost>` (mounted once at the app root, `app/layout.tsx`) renders
 * one `<ApprovalGateDialog>` per pending entry.
 *
 * Persistence: gates survive a reload, but the underlying approval-bus
 * waiter does NOT, so rehydration marks every restored gate `interrupted`.
 * An interrupted gate renders a Dismiss-only stale card (never live
 * Approve/Reject buttons that would resolve into the void). When the same
 * gate re-fires after reconnect, `open()` replaces the interrupted entry
 * with the fresh live one so it becomes answerable again.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { persistLocalStorage } from "@/stores/persist-storage"
import type { ApprovalKey } from "@/lib/runtime/approval-bus"

/**
 * ADR-0169 moved every Squad gate (plan, deadlock, teammate repair, re-plan,
 * capability audit, token budget) onto durable `ExecutionRunInterrupt`s.
 * What remains here is the non-Squad producers this store still serves.
 */
export type PendingGateType =
  /** The USD cost ceiling (`lib/usage/cost-budget-runtime.ts`). */
  | "budget"
  /** ADR-0045: an `approval_gate` step inside a running AgentPlan. */
  | "plan_step"

export type PendingGateStatus = "open" | "interrupted"

export interface PendingGate {
  key: ApprovalKey
  gateType: PendingGateType
  title: string
  body?: string
  /** The run the gate belongs to, when the producer has one (cost budget). */
  runId?: string
  /** Retained for row shape compatibility. Squad gates no longer live here. */
  teamId?: string
  taskId?: string
  /** Plan gates only — the chat session that owns the plan (navigation target). */
  sessionId?: string
  /** Plan gates only — the plan the blocked step belongs to. */
  planId?: string
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
  /** Drop every gate belonging to a plan (pause / cancel / terminal transition). */
  clearForPlan(planId: string): void
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
      clearForPlan: (planId) => set((s) => ({ gates: s.gates.filter((g) => g.planId !== planId) })),
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
 * Centralized here so the producers and the modal host agree.
 */
export function gateTypeFromScope(scope: string): PendingGateType {
  switch (scope) {
    // ADR-0045 `PLAN_APPROVAL_SCOPE`: a plan step's human checkpoint.
    case "agent-plan":
      return "plan_step"
    case "cost-budget":
    default:
      return "budget"
  }
}
