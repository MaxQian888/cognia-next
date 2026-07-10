/**
 * ApprovalJournalStore — durable mirror of chat tool approvals.
 *
 * The chat store is in-memory (by design), so a crash/restart silently drops
 * every live approval — the user never learns an ask was pending. This store
 * write-throughs each approval (record / settle / interrupt) to localStorage,
 * following the exact `pending-gates-store` pattern: the underlying sidecar
 * waiter dies with the page, so rehydration marks every unsettled entry
 * `interrupted` (info-only), and a one-shot boot notice tells the user how many
 * were interrupted.
 *
 * Small, transient, no queries → zustand persist (localStorage), not Dexie:
 * a Dexie table would demand a schema version + boot reconciliation for what is
 * by definition dead-on-reboot data.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"
import type { PendingApproval } from "@/lib/claude/types"

export type PersistedApprovalStatus = "pending" | "interrupted" | "settled"

export interface PersistedApproval {
  requestId: string
  /** The ephemeral/sub-session id `approveTool` needs (unused after reboot). */
  sessionId: string
  /** The UI bucket the ask surfaced in (parent chat / team session). */
  bucketSessionId: string
  toolName: string
  origin?: "subagent"
  subagentId?: string
  subagentRunId?: string
  requestedAt: number
  status: PersistedApprovalStatus
  interruptReason?: string
}

interface ApprovalJournalState {
  entries: PersistedApproval[]
  record(entry: Omit<PersistedApproval, "status">): void
  settle(requestId: string): void
  interrupt(requestId: string, reason?: string): void
  dismiss(requestId: string): void
  clearSettled(): void
}

/** FIFO cap — approvals are transient; never let the journal grow unbounded. */
const MAX_ENTRIES = 100

/**
 * The sidecar waiter died with the previous page — mark every unsettled
 * restored ask interrupted (info-only). Pure; exported for the rehydrate hook
 * and its test.
 */
export function markUnsettledInterrupted(entries: PersistedApproval[]): PersistedApproval[] {
  return entries.map((e) =>
    e.status === "interrupted" ? e : { ...e, status: "interrupted" as const }
  )
}

/** Migrate legacy persisted rows (any version) to interrupted. Pure. */
export function migrateApprovalJournal(persisted: unknown): {
  entries: PersistedApproval[]
} {
  const p = persisted as { entries?: Array<Partial<PersistedApproval>> } | undefined
  return {
    entries: (p?.entries ?? []).map((e) => ({ ...e, status: "interrupted" }) as PersistedApproval),
  }
}

export const useApprovalJournalStore = create<ApprovalJournalState>()(
  persist(
    (set) => ({
      entries: [],
      record: (entry) =>
        set((s) => {
          const rest = s.entries.filter((e) => e.requestId !== entry.requestId)
          const next = [...rest, { ...entry, status: "pending" as const }]
          return { entries: next.slice(-MAX_ENTRIES) }
        }),
      settle: (requestId) =>
        set((s) => ({ entries: s.entries.filter((e) => e.requestId !== requestId) })),
      interrupt: (requestId, reason) =>
        set((s) => ({
          entries: s.entries.map((e) =>
            e.requestId === requestId && e.status !== "interrupted"
              ? { ...e, status: "interrupted" as const, interruptReason: reason ?? "interrupted" }
              : e
          ),
        })),
      dismiss: (requestId) =>
        set((s) => ({ entries: s.entries.filter((e) => e.requestId !== requestId) })),
      clearSettled: () =>
        set((s) => ({ entries: s.entries.filter((e) => e.status !== "settled") })),
    }),
    {
      name: "cognia-approval-journal",
      version: 1,
      partialize: (s) => ({ entries: s.entries }),
      // The sidecar waiter died with the previous page — every restored ask is
      // unanswerable and must render as interrupted (info-only), not live.
      onRehydrateStorage: () => (state) => {
        if (!state) return
        state.entries = markUnsettledInterrupted(state.entries)
      },
      migrate: (persisted) =>
        migrateApprovalJournal(persisted) as Pick<ApprovalJournalState, "entries">,
    }
  )
)

/** Project a live `PendingApproval` (+ its UI bucket) into a persisted row. */
export function toPersistedApproval(
  approval: PendingApproval,
  bucketSessionId: string
): Omit<PersistedApproval, "status"> {
  return {
    requestId: approval.requestId,
    sessionId: approval.sessionId,
    bucketSessionId,
    toolName: approval.toolName,
    requestedAt: approval.requestedAt ?? Date.now(),
    ...(approval.origin ? { origin: approval.origin } : {}),
    ...(approval.subagentId ? { subagentId: approval.subagentId } : {}),
    ...(approval.subagentRunId ? { subagentRunId: approval.subagentRunId } : {}),
  }
}
