/**
 * Workspace files (ADR-0223 §8): what agents created, modified or renamed on
 * disk in a conversation's workspace, as Files lists them. Pure; the loaders
 * that ask the host live in `workspace-files-io.ts`.
 *
 * Two records, one list:
 *
 *  - The task-workspace ledger's resource index (`task_workspace_list_resource_index`)
 *    is the authority: the latest net change per conversation, root and path,
 *    already without deleted paths, credentials, build outputs and symlinks.
 *  - Code-adoption turns fill the gaps: a conversation whose runs have left
 *    the ledger (retention prunes whole tasks) still has its turn rows, which
 *    name the files an agent wrote. They are used only for conversations the
 *    index holds nothing for, so they can never bring back a file the ledger
 *    knows was deleted.
 *
 * Files never writes to or deletes these files on disk. Whether a file is
 * still there is checked when it is opened, read or downloaded.
 */

import type { CodeAdoptionTurnRow } from "@/lib/code-adoption/types"
import type { LibraryItemWorkspaceLocation } from "@/lib/db/files-library-types"
import { isSensitiveResourcePath } from "@/lib/task-workspace/run-changes"
import type { TaskResourceIndexEntry } from "@/lib/task-workspace/types"

/** One workspace file before the Files metadata is folded in. */
export interface RawWorkspaceFile extends LibraryItemWorkspaceLocation {
  change: "created" | "modified" | "renamed"
  oldPath?: string
  /**
   * The path the file's item id is derived from, when it is not `relPath`:
   * the path a renamed file had before its first rename, so a favorite or a
   * folder follows the file through the agent's renames.
   */
  identityPath?: string
  mediaType?: string
  byteSize?: number
  /** When an agent first put the file in the list (epoch ms). */
  createdAt: number
  /** When it changed last (epoch ms). */
  updatedAt: number
}

function fnv1a32(input: string, seed: number): number {
  let hash = seed >>> 0
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * The item source id of a workspace file: a stable 64-bit digest of where it
 * is, because a path can be longer than an item key may be. Not a security
 * primitive; it only has to be stable and well spread.
 */
export function workspaceFileSourceId(
  sessionId: string,
  workspaceRoot: string,
  relPath: string
): string {
  const text = `${sessionId}\n${workspaceRoot}\n${relPath}`
  const high = fnv1a32(text, 0x811c9dc5).toString(16).padStart(8, "0")
  const low = fnv1a32(text, 0x01000193).toString(16).padStart(8, "0")
  return `${high}${low}`
}

/** The file name of a workspace path. */
export function workspaceFileName(relPath: string): string {
  const parts = relPath.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? relPath
}

function normalizeRelPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\/+/, "")
}

function fromIndex(entry: TaskResourceIndexEntry): RawWorkspaceFile {
  return {
    sessionId: entry.sessionId,
    workspaceRoot: entry.workspaceRoot,
    executionRoot: entry.executionRoot,
    relPath: normalizeRelPath(entry.path),
    change: entry.kind,
    ...(entry.oldPath ? { oldPath: normalizeRelPath(entry.oldPath) } : {}),
    ...(entry.mediaType ? { mediaType: entry.mediaType } : {}),
    byteSize: entry.size,
    createdAt: entry.firstChangedAt,
    updatedAt: entry.changedAt,
    adoption: entry.adoption,
    runId: entry.runId,
  }
}

/** A turn, or a file in it, whose change was thrown away. */
function discarded(state: string | undefined): boolean {
  return state === "rejected" || state === "reverted"
}

/**
 * An in-app agent's turn that was never applied: its change lived only in
 * the run's own root, which went with the ledger rows that would name it, so
 * the workspace root holds the person's version, not the agent's.
 */
function neverApplied(turn: CodeAdoptionTurnRow, state: string | undefined): boolean {
  return turn.measurement === "taskWorkspace" && state === "pending"
}

/**
 * Turn rows of conversations the index does not hold, as workspace files:
 * newest turn wins per root and path, and a file any turn created stays
 * `created`. Credential-shaped paths stay out, as the ledger keeps them out.
 */
function fromAdoption(
  turns: readonly CodeAdoptionTurnRow[],
  covered: ReadonlySet<string>
): RawWorkspaceFile[] {
  const files = new Map<string, RawWorkspaceFile>()
  const ordered = [...turns].sort((a, b) => a.ts - b.ts)
  for (const turn of ordered) {
    if (covered.has(turn.sessionId) || discarded(turn.adoptionState)) continue
    if (neverApplied(turn, turn.adoptionState)) continue
    for (const file of turn.files) {
      if (discarded(file.adoptionState)) continue
      const relPath = normalizeRelPath(file.path)
      if (!relPath || isSensitiveResourcePath(relPath)) continue
      const key = `${turn.sessionId}\u0000${turn.workspaceRoot}\u0000${relPath}`
      const previous = files.get(key)
      files.set(key, {
        sessionId: turn.sessionId,
        workspaceRoot: turn.workspaceRoot,
        executionRoot: turn.workspaceRoot,
        relPath,
        change: previous?.change === "created" || file.isNew ? "created" : "modified",
        createdAt: previous?.createdAt ?? turn.ts,
        updatedAt: turn.ts,
      })
    }
  }
  return [...files.values()]
}

/**
 * Give each renamed file the id of the path it was first listed under. The
 * ledger carries that path through every rename (`oldPath`), so the id, and
 * with it the item's favorite and folder, survives them. A file now standing
 * at that path keeps it, and of two renamed files from one path the older
 * does; the other is known by where it is now. No two files share an id.
 */
function assignIdentities(files: RawWorkspaceFile[]): RawWorkspaceFile[] {
  const place = (file: RawWorkspaceFile, path: string) =>
    `${file.sessionId}\u0000${file.workspaceRoot}\u0000${path}`
  const occupied = new Set(files.map((file) => place(file, file.relPath)))
  const claimed = new Set<string>()
  const byAge = files
    .map((file, order) => ({ file, order }))
    .filter(({ file }) => file.oldPath && file.oldPath !== file.relPath)
    .sort((a, b) => a.file.createdAt - b.file.createdAt || a.order - b.order)
  const identities = new Map<number, string>()
  for (const { file, order } of byAge) {
    const origin = place(file, file.oldPath!)
    if (occupied.has(origin) || claimed.has(origin)) continue
    claimed.add(origin)
    identities.set(order, file.oldPath!)
  }
  return files.map((file, order) => {
    const identityPath = identities.get(order)
    return identityPath ? { ...file, identityPath } : file
  })
}

/**
 * Every workspace file Files lists: the index, then turn rows for the
 * conversations it no longer holds. `index` is null where there is no ledger
 * to ask, in which case the turn rows are all there is.
 */
export function mergeWorkspaceFiles(
  index: readonly TaskResourceIndexEntry[] | null,
  turns: readonly CodeAdoptionTurnRow[]
): RawWorkspaceFile[] {
  const listed = assignIdentities((index ?? []).map(fromIndex))
  const covered = new Set(listed.map((file) => file.sessionId))
  return [...listed, ...fromAdoption(turns, covered)]
}
