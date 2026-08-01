/**
 * The dock's single writer.
 *
 * dockview emits `onDidLayoutChange` continuously, including mid-drag, and that
 * event is not suppressible. If those emissions wrote straight to the store the
 * dock would have two writers racing — dockview reporting intermediate states
 * and the app committing intended ones — and the last one to land would win.
 * So dockview stays an *emitter* and this module is the only *writer*: every
 * mutation is a transaction with a monotonic revision, and a write carrying a
 * stale revision is rejected rather than applied out of order.
 *
 * History is deliberately in-memory and bounded. The final snapshot persists;
 * the undo stack does not survive a restart, because a layout you cannot see
 * any more is not one you can meaningfully undo into.
 */

import type { DockLayoutEnvelope } from "@/types/dock/layout"

/** How many structural mutations the in-session undo stack remembers. */
export const DOCK_HISTORY_LIMIT = 50

/** Why a commit was refused. */
export type DockTransactionRejection =
  /** The caller's `baseRevision` is behind the envelope's. */
  | "stale-revision"
  /** The transaction produced an envelope for a different layout key. */
  | "key-mismatch"

export interface DockTransaction {
  /** The revision the caller read before computing its change. */
  baseRevision: number
  /** Short, low-cardinality label for logs. Never free text from a user. */
  label: string
  /** Pure: given the current envelope, return the next one (without revision). */
  apply: (current: DockLayoutEnvelope) => DockLayoutEnvelope
  /**
   * Structural changes enter the undo stack; incidental ones (a resize settling,
   * an unread badge) do not. Undoing a badge would be noise.
   */
  structural?: boolean
}

export type DockCommitResult =
  | { ok: true; envelope: DockLayoutEnvelope }
  | { ok: false; rejection: DockTransactionRejection; envelope: DockLayoutEnvelope }

export interface DockHistoryState {
  past: DockLayoutEnvelope[]
  future: DockLayoutEnvelope[]
}

export const EMPTY_DOCK_HISTORY: DockHistoryState = { past: [], future: [] }

export interface DockCommitOutput {
  result: DockCommitResult
  history: DockHistoryState
}

function sameKey(a: DockLayoutEnvelope, b: DockLayoutEnvelope): boolean {
  return (
    a.key.accountId === b.key.accountId &&
    a.key.host === b.key.host &&
    a.key.contextId === b.key.contextId
  )
}

function trimPast(past: DockLayoutEnvelope[]): DockLayoutEnvelope[] {
  return past.length > DOCK_HISTORY_LIMIT ? past.slice(past.length - DOCK_HISTORY_LIMIT) : past
}

/**
 * Apply one transaction. Pure — returns the next envelope and history rather
 * than mutating either, so the store's reducer stays a plain assignment and the
 * whole engine is testable without React or zustand.
 */
export function commitDockTransaction(
  current: DockLayoutEnvelope,
  history: DockHistoryState,
  transaction: DockTransaction,
  now: number
): DockCommitOutput {
  if (transaction.baseRevision !== current.revision) {
    return {
      result: { ok: false, rejection: "stale-revision", envelope: current },
      history,
    }
  }

  const next = transaction.apply(current)
  if (!sameKey(current, next)) {
    return {
      result: { ok: false, rejection: "key-mismatch", envelope: current },
      history,
    }
  }

  const envelope: DockLayoutEnvelope = {
    ...next,
    revision: current.revision + 1,
    updatedAt: now,
  }

  // A new structural change invalidates the redo branch — the user chose a
  // different future.
  const nextHistory: DockHistoryState = transaction.structural
    ? { past: trimPast([...history.past, current]), future: [] }
    : history

  return { result: { ok: true, envelope }, history: nextHistory }
}

export interface DockHistoryStep {
  envelope: DockLayoutEnvelope
  history: DockHistoryState
}

/**
 * Step back one structural change. Returns `null` when there is nothing to
 * undo, so the caller can leave the command disabled rather than commit a no-op.
 *
 * The restored envelope keeps moving the revision *forward*: revisions are a
 * write-ordering guard, not a version number, and rewinding one would let a
 * write computed against the pre-undo state land afterwards.
 */
export function undoDockLayout(
  current: DockLayoutEnvelope,
  history: DockHistoryState,
  now: number
): DockHistoryStep | null {
  const previous = history.past.at(-1)
  if (!previous) return null
  return {
    envelope: { ...previous, revision: current.revision + 1, updatedAt: now },
    history: {
      past: history.past.slice(0, -1),
      future: [current, ...history.future],
    },
  }
}

/** Step forward again. `null` when the redo branch is empty. */
export function redoDockLayout(
  current: DockLayoutEnvelope,
  history: DockHistoryState,
  now: number
): DockHistoryStep | null {
  const next = history.future[0]
  if (!next) return null
  return {
    envelope: { ...next, revision: current.revision + 1, updatedAt: now },
    history: {
      past: trimPast([...history.past, current]),
      future: history.future.slice(1),
    },
  }
}

export function canUndoDockLayout(history: DockHistoryState): boolean {
  return history.past.length > 0
}

export function canRedoDockLayout(history: DockHistoryState): boolean {
  return history.future.length > 0
}
