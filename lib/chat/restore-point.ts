/**
 * "Go back to before this message" — what can actually be restored, and how.
 *
 * Restoring sits on several mechanisms that each cover part of the job:
 * editing a message keeps the original as a branch, branching copies the
 * thread up to a point, truncating deletes the tail, a turn's Undo reverts the
 * files that one turn changed, and an Agent SDK checkpoint rewinds files for
 * SDK turns when checkpointing is on. Offered as separate buttons, none of them
 * says what the others cover, so a user cannot tell what "back to here" would
 * give them. This module answers that for one user message; the restore
 * dialog (`components/chat/restore-point-dialog.tsx`) shows the answer and
 * routes each choice to the mechanism that owns it.
 *
 * Files are restored through the Task Workspace ledger — the same per-turn
 * patch the turn card's Undo reverts — newest turn first, so each undo applies
 * against the state the next-newer one left. That works for every runtime the
 * ledger measured, not only SDK sessions with checkpointing switched on.
 */

import type { UIMessage } from "ai"

import type { CodeAdoptionTurnRow } from "@/lib/code-adoption/types"
import type { ApplyOutcome, PatchSet } from "@/lib/task-workspace/types"

/** The Task Workspace run whose patch is this turn's diff, when there is one. */
export function turnPatchRunId(row: CodeAdoptionTurnRow): string | null {
  return row.measurement === "taskWorkspace" && row.taskWorkspaceRunId
    ? row.taskWorkspaceRunId
    : null
}

/**
 * The assistant messages after `messageId` in `messages` (pass the VISIBLE
 * thread), oldest first: the turns whose changes a restore to before this
 * message would take back. Empty when the message is not in the list.
 */
export function assistantMessagesAfter(
  messages: readonly Pick<UIMessage, "id" | "role">[],
  messageId: string
): string[] {
  const index = messages.findIndex((message) => message.id === messageId)
  if (index < 0) return []
  return messages
    .slice(index + 1)
    .filter((message) => message.role === "assistant")
    .map((message) => message.id)
}

/** One later turn's change record and the current state of its patch. */
export interface RestoreTurnState {
  row: CodeAdoptionTurnRow
  /** `null` when the turn has no ledger patch or it could not be read. */
  patch: PatchSet | null
}

export type FileRestoreBlock =
  /** A turn changed files the ledger only fingerprinted: there is no patch to revert. */
  | "untracked"
  /** A turn's patch kept no inverse, or is not in an applied state. */
  | "irreversible"

export type FileRestorePlan =
  /** No file changes were recorded after this message. */
  | { kind: "none" }
  /** Every change after this message has already been undone. */
  | { kind: "undone" }
  /** Revertible: these runs, newest first. */
  | { kind: "undoable"; runIds: string[]; turns: number; files: number }
  /** At least one turn cannot be reverted; nothing is undone. */
  | { kind: "blocked"; reason: FileRestoreBlock; turns: number; files: number }

/**
 * Decide whether the files changed after a message can be restored, from the
 * later turns' records (oldest first). All or nothing: undoing only the turns
 * that happen to be revertible would leave the tree in a state no point in
 * the conversation ever had.
 */
export function planFileRestore(states: readonly RestoreTurnState[]): FileRestorePlan {
  const changed = states.filter(
    ({ row }) => row.totalFiles > 0 && row.trackingState !== "unavailable"
  )
  if (changed.length === 0) return { kind: "none" }
  const paths = new Set(changed.flatMap(({ row }) => row.files.map((file) => file.path)))
  const files = paths.size || changed.reduce((sum, { row }) => sum + row.totalFiles, 0)
  const pending = changed.filter(
    ({ row, patch }) => patch?.state !== "reverted" && row.adoptionState !== "reverted"
  )
  if (pending.length === 0) return { kind: "undone" }
  for (const { row, patch } of pending) {
    if (!turnPatchRunId(row) || !patch) {
      return { kind: "blocked", reason: "untracked", turns: pending.length, files }
    }
    if (patch.state !== "applied" || !patch.reversible) {
      return { kind: "blocked", reason: "irreversible", turns: pending.length, files }
    }
  }
  const runIds = pending.map(({ row }) => turnPatchRunId(row)!).reverse()
  return { kind: "undoable", runIds, turns: pending.length, files }
}

export type FileRestoreOutcome =
  | { state: "reverted"; undone: number }
  /** Stopped at `runId`: a later edit conflicts with its inverse. */
  | { state: "conflict"; undone: number; runId: string; conflicts: number }
  /** Stopped at `runId`: the ledger did not revert it (already moved on). */
  | { state: "notReverted"; undone: number; runId: string }

/**
 * Undo `runIds` (newest first) one at a time, stopping at the first that does
 * not revert cleanly — the ledger reports a conflict rather than overwriting a
 * later edit, and continuing past it would undo older turns underneath it.
 */
export async function runFileRestore(
  runIds: readonly string[],
  undo: (runId: string) => Promise<ApplyOutcome>
): Promise<FileRestoreOutcome> {
  let undone = 0
  for (const runId of runIds) {
    const outcome = await undo(runId)
    if (outcome.state === "conflict") {
      return { state: "conflict", undone, runId, conflicts: outcome.conflicts.length }
    }
    if (outcome.state !== "reverted") return { state: "notReverted", undone, runId }
    undone += 1
  }
  return { state: "reverted", undone }
}
