/**
 * Projects durable Task Workspace review decisions into local adoption rows.
 * Patch bodies never enter Dexie: partial-apply accounting uses only the
 * per-hunk added/deleted counters persisted by the patch ledger.
 */

import type { PatchSet } from "@/lib/task-workspace/types"

import { getCodeAdoptionTurnByTaskWorkspaceRun, persistCodeAdoptionTurn } from "./persist"
import type { CodeAdoptionFile, CodeAdoptionState, CodeAdoptionTurnRow } from "./types"

export type TaskWorkspaceOutcomeKind = "apply" | "undo" | "keepCurrent"

function zeroAccepted(file: CodeAdoptionFile, state: CodeAdoptionState): CodeAdoptionFile {
  return { ...file, acceptedAdded: 0, acceptedRemoved: 0, adoptionState: state }
}

function acceptedFile(
  file: CodeAdoptionFile,
  patch: PatchSet["files"][number] | undefined,
  hunkIds: string[] | null
): CodeAdoptionFile {
  if (hunkIds === null || hunkIds.length === 0) {
    return {
      ...file,
      acceptedAdded: file.added,
      acceptedRemoved: file.removed,
      adoptionState: "accepted",
    }
  }
  const selected = new Set(hunkIds)
  const hunks = patch?.hunks.filter((hunk) => selected.has(hunk.id)) ?? []
  const acceptedAdded = Math.min(
    file.added,
    hunks.reduce((sum, hunk) => sum + (hunk.additions ?? 0), 0)
  )
  const acceptedRemoved = Math.min(
    file.removed,
    hunks.reduce((sum, hunk) => sum + (hunk.deletions ?? 0), 0)
  )
  const complete = acceptedAdded === file.added && acceptedRemoved === file.removed
  return {
    ...file,
    acceptedAdded,
    acceptedRemoved,
    adoptionState: complete ? "accepted" : "partiallyAccepted",
  }
}

function summarize(row: CodeAdoptionTurnRow, files: CodeAdoptionFile[]): CodeAdoptionTurnRow {
  const acceptedAdded = files.reduce((sum, file) => sum + (file.acceptedAdded ?? 0), 0)
  const acceptedRemoved = files.reduce((sum, file) => sum + (file.acceptedRemoved ?? 0), 0)
  const acceptedFiles = files.filter(
    (file) => file.adoptionState === "accepted" || file.adoptionState === "partiallyAccepted"
  ).length
  const proposedFiles = row.proposedFiles ?? row.totalFiles
  const proposedAdded = row.proposedAdded ?? row.totalAdded
  const proposedRemoved = row.proposedRemoved ?? row.totalRemoved
  const complete =
    acceptedFiles === proposedFiles &&
    acceptedAdded === proposedAdded &&
    acceptedRemoved === proposedRemoved
  return {
    ...row,
    files,
    proposedFiles,
    proposedAdded,
    proposedRemoved,
    acceptedFiles,
    acceptedAdded,
    acceptedRemoved,
    adoptionState: complete ? "accepted" : "partiallyAccepted",
    adoptionReason: undefined,
  }
}

/** Best-effort caller: failures must never alter the already-completed apply/undo action. */
export async function recordTaskWorkspaceOutcome(
  patch: PatchSet,
  kind: TaskWorkspaceOutcomeKind = patch.state === "reverted" ? "undo" : "apply"
): Promise<void> {
  const row = await getCodeAdoptionTurnByTaskWorkspaceRun(patch.runId)
  if (!row || row.measurement !== "taskWorkspace") return

  if (kind === "undo" || kind === "keepCurrent" || patch.state === "reverted") {
    const state: CodeAdoptionState = kind === "keepCurrent" ? "rejected" : "reverted"
    await persistCodeAdoptionTurn({
      ...row,
      files: row.files.map((file) => zeroAccepted(file, state)),
      adoptionState: state,
      acceptedFiles: 0,
      acceptedAdded: 0,
      acceptedRemoved: 0,
    })
    return
  }
  if (patch.state !== "applied") return
  if (patch.appliedSelectionKnown !== true) {
    await persistCodeAdoptionTurn({
      ...row,
      adoptionState: "unavailable",
      adoptionReason: "appliedSelectionUnknown",
    })
    return
  }

  const appliesAll = (patch.appliedSelection?.length ?? 0) === 0
  const selections = new Map(
    (patch.appliedSelection ?? []).map((selection) => [selection.path, selection.hunkIds])
  )
  const files = row.files.map((file) => {
    const selected = appliesAll ? null : selections.get(file.path)
    if (selected === undefined) return zeroAccepted(file, "rejected")
    return acceptedFile(
      file,
      patch.files.find((candidate) => candidate.path === file.path),
      selected
    )
  })
  await persistCodeAdoptionTurn(summarize(row, files))
}
