/**
 * Drives the {@link createCheckpointStore} shadow-backup store from the turn
 * lifecycle so `/rewind` has checkpoints to restore.
 *
 * Model: a checkpoint represents the state *before* a turn. Its `cellCount` is
 * captured at the turn's prompt boundary (`beginTurn`), and its file shadows are
 * the original bytes recorded the first time that turn mutates each file
 * (`onToolCall`). Because shadows are only known once the turn has run, a
 * segment is committed lazily — at the next `beginTurn`, or on demand via
 * `list()` (which flushes the open segment so the most recent turn is rewindable
 * without waiting for another prompt).
 *
 * Pure-ish: the store fs + clock are injected, so it unit-tests without disk.
 */
import {
  createCheckpointStore,
  type Checkpoint,
  type CheckpointFs,
  type CheckpointStore,
} from "./checkpoint-store"
import { MUTATING_TOOLS } from "./pre-tool-seam"

export interface CheckpointCaptureDeps {
  home: string
  /** Resolve the live session id at call time (it can change on /clear, /resume,
   * and is minted by the session itself — so it's read lazily, not baked in). */
  getSessionId: () => string
  fs: CheckpointFs
  /** Injectable store (defaults to a real one over `fs`). */
  store?: CheckpointStore
  /** Clock for checkpoint timestamps (injected for deterministic tests). */
  now?: () => number
  /** Override the mutating-tool set (defaults to {@link MUTATING_TOOLS}). */
  mutating?: Set<string>
}

export interface CheckpointCapture {
  /** Prompt boundary: commit the prior turn's segment, start tracking this one. */
  beginTurn(cellCount: number, label: string): void
  /** A tool is about to run; snapshot the target file if the tool mutates it. */
  onToolCall(toolName: string, input: unknown): void
  /** Flush the open segment and return all checkpoints, newest-first. */
  list(): Checkpoint[]
  /** The underlying store (for restore). */
  readonly store: CheckpointStore
}

/** Pull a file path out of a tool's input (Edit/Write/… use `file_path`). */
function filePathOf(input: unknown): string | null {
  if (!input || typeof input !== "object") return null
  const obj = input as Record<string, unknown>
  for (const key of ["file_path", "filePath", "path", "notebook_path"]) {
    const value = obj[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  return null
}

export function createCheckpointCapture(deps: CheckpointCaptureDeps): CheckpointCapture {
  const store = deps.store ?? createCheckpointStore({ home: deps.home, fs: deps.fs })
  const now = deps.now ?? (() => 0)
  const mutating = deps.mutating ?? MUTATING_TOOLS

  let openedFor: string | null = null
  let pending: { cellCount: number; label: string } | null = null
  let seq = 0

  // Open a fresh segment when the session changes (first use, /clear, /resume).
  const ensureOpen = (sid: string): void => {
    if (openedFor === sid) return
    store.openSegment(sid)
    openedFor = sid
    pending = null
  }

  const commitPending = (sid: string): void => {
    if (!pending) return
    store.commitCheckpoint(sid, {
      cellCount: pending.cellCount,
      label: pending.label,
      ts: now(),
      seq: seq++,
    })
    pending = null
  }

  return {
    store,
    beginTurn(cellCount, label) {
      const sid = deps.getSessionId()
      if (!sid) return
      ensureOpen(sid)
      // Commit the previous turn's segment (its shadows are now complete), then
      // start tracking this turn. The store auto-opens the next segment on commit.
      commitPending(sid)
      pending = { cellCount, label }
    },
    onToolCall(toolName, input) {
      if (!mutating.has(toolName)) return
      const sid = deps.getSessionId()
      if (!sid) return
      ensureOpen(sid)
      const path = filePathOf(input)
      if (path) store.recordPreMutation(sid, path)
    },
    list() {
      const sid = deps.getSessionId()
      if (!sid) return []
      ensureOpen(sid)
      // Flush so the most recent (still-open) turn is listable.
      commitPending(sid)
      return store.listCheckpoints(sid)
    },
  }
}
