/**
 * "What did this conversation change?" — the files a chat touched, as paths
 * inside one repository, so the dock's review can narrow the working tree's
 * changes to them.
 *
 * Two records, merged because each covers what the other misses:
 *
 * - The tool calls in the conversation (Write / Edit / MultiEdit /
 *   NotebookEdit / apply_patch): on every host, and live for the turn still
 *   running, but blind to a file a shell command rewrote.
 * - The code-adoption turns (`codeAdoptionTurns`): the desktop host diffs the
 *   working tree around each settled turn, so it sees every write, shell
 *   included, but only once the turn has settled and only on desktop.
 *
 * The comparison itself is unchanged: a narrowed review still shows each
 * file's diff against the index / HEAD, not against the moment the
 * conversation started, and says so.
 */

import type { UIMessage } from "ai"
import type { CodeAdoptionTurnRow } from "@/lib/code-adoption/types"
import { isPathWithinRoot, relativePathWithinRoot } from "@/lib/files/permissions"
import { resolveLinkPath } from "@/lib/terminal/terminal-links"
import { resolveToolPartName } from "@/lib/chat/tool-summary"
import { parseUnifiedPatch } from "@/lib/git/unified-patch"
import type { GitFileChange, GitStatus } from "@/types/git"

/** Tool names (namespace-folded, lower-cased) that write the file they name. */
const EDIT_TOOLS = new Set([
  "write",
  "create",
  "edit",
  "str_replace",
  "multiedit",
  "multi_edit",
  "notebookedit",
  "apply_patch",
])

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined
}

/** Paths one file-editing tool input names, as the agent wrote them. */
function inputPaths(name: string, input: Record<string, unknown>): string[] {
  if (name === "apply_patch") {
    const patch = str(input.patch)
    if (!patch) return []
    const out: string[] = []
    for (const file of parseUnifiedPatch(patch)) {
      if (file.oldPath) out.push(file.oldPath)
      if (file.newPath && file.newPath !== file.oldPath) out.push(file.newPath)
    }
    return out
  }
  const out = [str(input.file_path), str(input.path), str(input.notebook_path)].filter(
    (p): p is string => Boolean(p)
  )
  // A multi-file MultiEdit spelling: one path per edit.
  if (Array.isArray(input.edits)) {
    for (const edit of input.edits) {
      const p =
        edit && typeof edit === "object"
          ? str((edit as Record<string, unknown>).file_path)
          : undefined
      if (p) out.push(p)
    }
  }
  return out
}

/**
 * Every path the conversation's completed file-editing tool calls wrote, as
 * written (absolute, or relative to the session's working directory). A call
 * that failed, was denied or is still waiting wrote nothing.
 */
export function editedPathsFromMessages(messages: readonly UIMessage[]): string[] {
  const out: string[] = []
  for (const message of messages) {
    if (message.role !== "assistant") continue
    for (const part of message.parts ?? []) {
      const p = part as { type?: string; toolName?: string; state?: string; input?: unknown }
      if (!p.type || (!p.type.startsWith("tool-") && p.type !== "dynamic-tool")) continue
      if (p.state !== "output-available") continue
      const name = resolveToolPartName(p)?.toLowerCase()
      if (!name || !EDIT_TOOLS.has(name)) continue
      if (!p.input || typeof p.input !== "object") continue
      out.push(...inputPaths(name, p.input as Record<string, unknown>))
    }
  }
  return out
}

/**
 * Repository-relative paths (forward slashes) the conversation touched in the
 * repository at `rootPath`.
 */
export function conversationRepoPaths({
  rootPath,
  toolPaths,
  turns,
}: {
  rootPath: string
  toolPaths: readonly string[]
  turns: readonly CodeAdoptionTurnRow[]
}): Set<string> {
  const paths = new Set<string>()
  for (const raw of toolPaths) {
    const rel = relativePathWithinRoot(resolveLinkPath(rootPath, raw), rootPath)
    if (rel) paths.add(rel)
  }
  for (const turn of turns) {
    // A turn records paths relative to its repository's working tree; it
    // counts here when it ran in this repository (its root, or a folder in it).
    if (!isPathWithinRoot(turn.workspaceRoot, rootPath)) continue
    for (const file of turn.files) paths.add(file.path.replace(/\\/g, "/"))
  }
  return paths
}

function inScope(change: GitFileChange, paths: ReadonlySet<string>): boolean {
  return paths.has(change.path) || (change.origPath !== null && paths.has(change.origPath))
}

/** `status` narrowed to the changes whose path (or rename source) is in `paths`. */
export function scopeStatus(status: GitStatus, paths: ReadonlySet<string>): GitStatus {
  return {
    ...status,
    staged: status.staged.filter((c) => inScope(c, paths)),
    changes: status.changes.filter((c) => inScope(c, paths)),
    merge: status.merge.filter((c) => inScope(c, paths)),
  }
}

/** Distinct changed paths across every group. */
export function changedPathCount(status: GitStatus | null | undefined): number {
  if (!status) return 0
  return new Set([...status.staged, ...status.changes, ...status.merge].map((c) => c.path)).size
}
