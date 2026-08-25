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

/** Prefix so a slot key can never collide with an id from another namespace. */
const LOCAL_PREFIX = "dir:"
const REMOTE_PREFIX = "env:"

/**
 * A remote environment is the unit of exclusion, whatever path it reports: two
 * turns in one sandbox conflict exactly the way two turns in one directory do,
 * and the path they report is meaningless outside that sandbox.
 */
function remoteSlotKey(context: SessionExecutionContext | null | undefined): string | undefined {
  const environmentId = context?.environmentId?.trim()
  if (!environmentId || context?.location === "local") return undefined
  return `${REMOTE_PREFIX}${environmentId}`
}

export interface SlotKeyForTurnInput {
  /** The conversation's durable binding, for the remote-environment case. */
  executionContext?: SessionExecutionContext | null
  /**
   * The directory the turn will ACTUALLY run in — `resolveEffectiveCwd`, the
   * same chain the send path and every cwd surface use.
   */
  effectiveCwd?: string | null
}

/**
 * The slot a turn occupies, or `undefined` when it occupies none.
 *
 * # Why the effective cwd and not the binding
 *
 * The binding (`resolveSessionWorkspaceRoot`) is only the MIDDLE link of the
 * cwd chain: a per-session `workingDir` override sits above it and the
 * workspace root, character default and app default sit below. Keying the slot
 * off the binding alone got both ends wrong:
 *
 *  - two ordinary conversations in one workspace have no binding at all, so
 *    both got `undefined` and were never serialized — while both ran in the
 *    workspace's primary root. That is the headline case in the header above,
 *    and it was the one case the slot did not cover;
 *  - a session with `workingDir = /a` and a binding naming `/b` took the slot
 *    for `/b`, serializing against a tree it never touches while leaving `/a`
 *    unprotected;
 *  - a managed binding whose worktree is not materialized resolves to nothing,
 *    yet the turn still falls back to the project root and runs there.
 *
 * One chain for "where does this run" and "what does it exclude", or the two
 * answers drift and the exclusion guards the wrong directory.
 */
export function slotKeyForTurn(input: SlotKeyForTurnInput): string | undefined {
  return remoteSlotKey(input.executionContext) ?? slotKeyForPath(input.effectiveCwd)
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
