/**
 * Account sync's runtime state (ADR-0215 phases 2 and 3a), fed by the
 * foreground poller (`hooks/account-sync/use-account-sync-poller.ts`) and the
 * data engine (`hooks/account-sync/use-account-sync-engine.ts`), read by the
 * account page's sync section and the dialogs. Not persisted: every value is
 * re-derived from the verified list and the database on the next look.
 */

import { create } from "zustand"

import type { AccountSyncEngine, EngineStatus } from "@/lib/account-sync/data/engine"
import type { IncomingRequest } from "@/lib/account-sync/enrollment/approve"
import type { AccountSyncContext } from "@/lib/account-sync/enrollment/context"
import type { AccountSyncView, PollResult } from "@/lib/account-sync/poll"

export interface AccountSyncPollError {
  message: string
  failures: number
}

export interface AccountSyncState {
  view: AccountSyncView
  incoming: IncomingRequest[]
  /** The context the last look used; actions reuse it (and its server clock offset). */
  context: AccountSyncContext | null
  lastPolledAt: number | null
  error: AccountSyncPollError | null
  /** The request the approval dialog shows, or null when it is closed. */
  approvalRequestId: string | null
  /** Bumped to ask the poller to look now (after an action). */
  refreshNonce: number
  /** The running data engine of this window, or null (flag off, not enrolled, a mirror). */
  engine: AccountSyncEngine | null
  /** What the engine reports; null while none runs. */
  engineStatus: EngineStatus | null
  /** Whether the merge-or-replace dialog is open (it opens when the engine asks). */
  joinDialogOpen: boolean

  applyPoll: (result: PollResult, context: AccountSyncContext | null, at: number) => void
  failPoll: (message: string) => void
  openApproval: (requestId: string) => void
  closeApproval: () => void
  requestRefresh: () => void
  setEngine: (engine: AccountSyncEngine | null) => void
  setEngineStatus: (status: EngineStatus | null) => void
  setJoinDialogOpen: (open: boolean) => void
  reset: () => void
}

const INITIAL = {
  view: { kind: "idle" } as AccountSyncView,
  incoming: [] as IncomingRequest[],
  context: null,
  lastPolledAt: null,
  error: null,
  approvalRequestId: null,
  refreshNonce: 0,
  engine: null,
  engineStatus: null,
  joinDialogOpen: false,
}

export const useAccountSyncStore = create<AccountSyncState>()((set) => ({
  ...INITIAL,
  applyPoll: (result, context, at) =>
    set({ view: result.view, incoming: result.incoming, context, lastPolledAt: at, error: null }),
  failPoll: (message) =>
    set((state) => ({ error: { message, failures: (state.error?.failures ?? 0) + 1 } })),
  openApproval: (requestId) => set({ approvalRequestId: requestId }),
  closeApproval: () => set({ approvalRequestId: null }),
  requestRefresh: () => set((state) => ({ refreshNonce: state.refreshNonce + 1 })),
  setEngine: (engine) => set(engine ? { engine } : { engine: null, engineStatus: null }),
  setEngineStatus: (engineStatus) =>
    set((state) => ({
      engineStatus,
      // Asking opens the dialog once; leaving the choice closes it.
      joinDialogOpen:
        engineStatus?.kind === "join-choice"
          ? state.engineStatus?.kind === "join-choice"
            ? state.joinDialogOpen
            : true
          : false,
    })),
  setJoinDialogOpen: (joinDialogOpen) => set({ joinDialogOpen }),
  reset: () => set({ ...INITIAL }),
}))
