/**
 * Names the EXECUTION SLOT a turn will work in.
 *
 * # Why a cap was never enough
 *
 * The broker admits up to sixteen legs at once. That answers "how much work is
 * running"; it never answered "may these two run in the SAME directory". Two
 * conversations bound to one checkout, or a scheduled task firing into the
 * worktree a chat is already using, both fit comfortably under the cap and
 * then interleave edits, builds and git operations in one tree — the class of
 * corruption that makes people turn concurrency off.
 *
 * Serializing per slot is what makes "parallel across slots" safe to offer.
 * The slot is the DIRECTORY, not the workspace: a workspace with three managed
 * worktrees is three slots, and holding one must not block the others. That is
 * the whole point of cutting a worktree.
 *
 * # What has no slot
 *
 * A turn that mutates nothing shared — a cloud-only runtime, a read-only
 * query, a conversation with no execution binding at all — gets `undefined`
 * and is not serialized against anything. Inventing a slot for those would
 * queue work that never conflicts.
 */

import type { SessionExecutionContext } from "@/types/execution-context"

import { resolveSessionWorkspaceRoot } from "@/lib/task-workspace/session-execution-context"

/** Prefix so a slot key can never collide with an id from another namespace. */
const LOCAL_PREFIX = "dir:"
const REMOTE_PREFIX = "env:"

/**
 * The slot a conversation's turns occupy, or `undefined` when they occupy
 * none.
 *
 * A remote environment is its own slot keyed by environment id: two turns in
 * one sandbox conflict exactly the way two turns in one directory do, and the
 * path they report is meaningless outside that sandbox.
 */
export function slotKeyForExecutionContext(
  context: SessionExecutionContext | null | undefined
): string | undefined {
  if (!context) return undefined

  // A remote environment is the unit of exclusion, whatever path it reports.
  const environmentId = context.environmentId?.trim()
  if (environmentId && context.location !== "local") {
    return `${REMOTE_PREFIX}${environmentId}`
  }

  const root = resolveSessionWorkspaceRoot(context)?.trim()
  if (!root) return undefined
  return `${LOCAL_PREFIX}${normalizeSlotPath(root)}`
}

/** The slot a bare directory occupies — for callers that have a path already. */
export function slotKeyForPath(path: string | null | undefined): string | undefined {
  const trimmed = path?.trim()
  return trimmed ? `${LOCAL_PREFIX}${normalizeSlotPath(trimmed)}` : undefined
}

/**
 * Trailing separators stripped and Windows paths lowercased, so `/repo` and
 * `/repo/` are one slot rather than two that fail to exclude each other.
 */
function normalizeSlotPath(path: string): string {
  let normalized = path
  while (normalized.length > 1 && (normalized.endsWith("/") || normalized.endsWith("\\"))) {
    normalized = normalized.slice(0, -1)
  }
  return /^[A-Za-z]:[\\/]/.test(normalized) || normalized.includes("\\")
    ? normalized.toLowerCase()
    : normalized
}
