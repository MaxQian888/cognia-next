/**
 * Checkpoint store — shadow-copy backups of files mutated since the last
 * checkpoint, so a turn's filesystem effects can be rewound.
 *
 * A *segment* is the window between two checkpoints. The first time a path is
 * touched within an open segment, `recordPreMutation` snapshots its current
 * bytes into a shadow file (or records a tombstone when the path didn't exist).
 * `commitCheckpoint` freezes the segment to a `meta.json` and opens the next
 * one, so the very next mutation is captured afresh rather than deduped against
 * the just-committed segment.
 *
 * Everything is injectable: the store touches disk only through the supplied
 * {@link CheckpointFs}, and the pure path takes `ts`/`seq` as parameters rather
 * than reading the clock. In-memory segment bookkeeping lives on the instance;
 * the durable record (shadows + meta) lives under
 * `<home>/checkpoints/<sessionId>/<segment>/`.
 */
import path from "node:path"

/** Filesystem seam — supply a real implementation in production, a map in tests. */
export interface CheckpointFs {
  /** Read a file's bytes, or `null` when it does not exist. */
  read(p: string): string | null
  /** Write (creating/overwriting) a file. */
  write(p: string, d: string): void
  /** Remove a file (no-op when absent). */
  rm(p: string): void
  /** Whether a path currently exists. */
  exists(p: string): boolean
  /** Ensure a directory (recursively) exists. */
  mkdirp(p: string): void
  /** List entries whose path begins with the given prefix. */
  listDir(p: string): string[]
}

/**
 * A reference to one file's pre-mutation state. `shadowPath` points at the
 * shadow copy of the original bytes; `null` marks a *tombstone* — the file did
 * not exist when the segment opened, so restoring deletes it.
 */
export interface ShadowRef {
  absPath: string
  /** Path to the shadow copy, or `null` for a tombstone. */
  shadowPath: string | null
}

/** A committed checkpoint: an immutable snapshot of one segment. */
export interface Checkpoint {
  id: string
  seq: number
  sessionId: string
  ts: number
  label: string
  cellCount: number
  files: ShadowRef[]
}

/** Metadata accepted when committing a segment. `ts`/`seq` are injected. */
export interface CheckpointMeta {
  cellCount: number
  label: string
  ts: number
  seq: number
}

/** Scope flags for {@link CheckpointStore.restore}. */
export interface RestoreScope {
  files: boolean
  /** Conversation rewind is handled by the controller; `restore` ignores it. */
  conversation: boolean
}

export interface CheckpointStore {
  /** Open a fresh segment for a session, discarding any uncommitted state. */
  openSegment(sessionId: string): void
  /**
   * Snapshot a file's current bytes the first time it is mutated in the open
   * segment. Subsequent calls for the same path in the same segment are no-ops.
   * If no segment is open one is opened implicitly.
   */
  recordPreMutation(sessionId: string, absPath: string): void
  /** Freeze the open segment into a {@link Checkpoint} and open the next one. */
  commitCheckpoint(sessionId: string, meta: CheckpointMeta): Checkpoint
  /** Committed checkpoints for a session, newest-first. */
  listCheckpoints(sessionId: string): Checkpoint[]
  /** Restore a checkpoint's file effects. `scope.conversation` is ignored here. */
  restore(cp: Checkpoint, scope: RestoreScope): void
}

/** In-memory state for one open segment. */
interface OpenSegment {
  /** Monotonic segment index within the session. */
  index: number
  /** Recorded shadow refs, keyed by absolute path (dedupes per segment). */
  refs: Map<string, ShadowRef>
}

/** Root directory holding every session's checkpoints. */
function checkpointsRoot(home: string): string {
  return path.join(home, "checkpoints")
}

/** Directory for one session's checkpoints. */
function sessionDir(home: string, sessionId: string): string {
  return path.join(checkpointsRoot(home), sessionId)
}

/** Directory for one segment within a session. */
function segmentDir(home: string, sessionId: string, index: number): string {
  return path.join(sessionDir(home, sessionId), String(index))
}

/**
 * Deterministic, filesystem-safe key for an absolute path — used as the shadow
 * file name so each path maps to exactly one shadow within a segment. A plain
 * FNV-1a hash keeps the name short and avoids separator/casing pitfalls.
 */
function hashOfPath(absPath: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < absPath.length; i++) {
    h ^= absPath.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

/** Create a checkpoint store backed by the supplied fs seam. */
export function createCheckpointStore(opts: { home: string; fs: CheckpointFs }): CheckpointStore {
  const { home, fs } = opts
  /** Open (uncommitted) segment per session. */
  const open = new Map<string, OpenSegment>()
  /** Next segment index per session, seeded from already-committed segments. */
  const nextIndex = new Map<string, number>()

  /** Highest committed segment index on disk for a session (-1 when none). */
  function maxCommittedIndex(sessionId: string): number {
    const dir = sessionDir(home, sessionId)
    let max = -1
    for (const entry of fs.listDir(dir)) {
      // Match `<dir>/<index>/meta.json` shadow records.
      const rel = entry.slice(dir.length).replace(/^[\\/]+/, "")
      const seg = rel.split(/[\\/]/)[0]
      if (/^\d+$/.test(seg)) max = Math.max(max, Number(seg))
    }
    return max
  }

  /** Allocate the next segment index for a session. */
  function allocIndex(sessionId: string): number {
    const cached = nextIndex.get(sessionId)
    const idx = cached ?? maxCommittedIndex(sessionId) + 1
    nextIndex.set(sessionId, idx + 1)
    return idx
  }

  function openSegment(sessionId: string): void {
    open.set(sessionId, { index: allocIndex(sessionId), refs: new Map() })
  }

  /** Get the open segment, opening one implicitly when absent. */
  function ensureSegment(sessionId: string): OpenSegment {
    let seg = open.get(sessionId)
    if (!seg) {
      openSegment(sessionId)
      seg = open.get(sessionId)!
    }
    return seg
  }

  function recordPreMutation(sessionId: string, absPath: string): void {
    const seg = ensureSegment(sessionId)
    if (seg.refs.has(absPath)) return // dedupe: first touch wins.

    const current = fs.read(absPath)
    if (current == null) {
      // The file did not exist — restoring should delete whatever was created.
      seg.refs.set(absPath, { absPath, shadowPath: null })
      return
    }

    const dir = path.join(segmentDir(home, sessionId, seg.index), "shadow")
    fs.mkdirp(dir)
    const shadowPath = path.join(dir, hashOfPath(absPath))
    fs.write(shadowPath, current)
    seg.refs.set(absPath, { absPath, shadowPath })
  }

  function commitCheckpoint(sessionId: string, meta: CheckpointMeta): Checkpoint {
    const seg = ensureSegment(sessionId)
    const cp: Checkpoint = {
      id: `${sessionId}-${seg.index}`,
      seq: meta.seq,
      sessionId,
      ts: meta.ts,
      label: meta.label,
      cellCount: meta.cellCount,
      files: [...seg.refs.values()],
    }

    const dir = segmentDir(home, sessionId, seg.index)
    fs.mkdirp(dir)
    fs.write(path.join(dir, "meta.json"), JSON.stringify(cp))

    // Freeze this segment and open the next, so the next mutation is captured
    // fresh rather than deduped against this one.
    open.delete(sessionId)
    openSegment(sessionId)
    return cp
  }

  function listCheckpoints(sessionId: string): Checkpoint[] {
    const dir = sessionDir(home, sessionId)
    const metas: Checkpoint[] = []
    for (const entry of fs.listDir(dir)) {
      if (!entry.endsWith("meta.json")) continue
      const raw = fs.read(entry)
      if (raw == null) continue
      try {
        metas.push(JSON.parse(raw) as Checkpoint)
      } catch {
        // Skip a corrupt meta rather than break the listing.
      }
    }
    // Newest-first: higher ts leads, ties broken by higher seq.
    return metas.sort((a, b) => b.ts - a.ts || b.seq - a.seq)
  }

  function restore(cp: Checkpoint, scope: RestoreScope): void {
    // `scope.conversation` is intentionally ignored — conversation rewind is the
    // controller's job; this store only owns file effects.
    if (!scope.files) return
    for (const ref of cp.files) {
      if (ref.shadowPath == null) {
        // Tombstone: the file was created after the checkpoint — delete it.
        fs.rm(ref.absPath)
        continue
      }
      const bytes = fs.read(ref.shadowPath)
      if (bytes == null) continue // shadow missing — best-effort, skip.
      fs.write(ref.absPath, bytes)
    }
  }

  return { openSegment, recordPreMutation, commitCheckpoint, listCheckpoints, restore }
}
