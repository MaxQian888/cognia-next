/**
 * Checkpoint store — shadow-copy backups of files mutated since the last
 * checkpoint, so a turn's filesystem effects can be rewound.
 *
 * A *segment* is the window between two checkpoints. The first time a path is
 * touched within an open segment, `recordPreMutation` snapshots its current
 * bytes into a shadow file (or records a tombstone when the path didn't exist).
 * `recordSnapshot` takes the same record from bytes the sidecar read before
 * the tool ran, which is the only ordering-safe source for a write the user
 * did not have to approve.
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
import nodeFs from "node:fs"
import path from "node:path"

/** Filesystem seam — supply a real implementation in production, a map in tests. */
export interface CheckpointFs {
  /** Read a file's bytes, or `null` when it does not exist. */
  read(p: string): string | null
  /** Write (creating/overwriting) a file. */
  write(p: string, d: string): void
  /**
   * Byte-exact read/write for shadows, so a binary file restores intact. A
   * seam without them falls back to the text methods.
   */
  readBytes?(p: string): Uint8Array | null
  writeBytes?(p: string, d: Uint8Array): void
  /** Remove a file or a directory tree (no-op when absent). */
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
  /**
   * What stood at the path before. Absent on records written before
   * directories were tracked: those read as `file` with a shadow, `absent`
   * without one. A `directory` is recreated (empty) on restore; an `absent`
   * path is removed, whole tree included.
   */
  before?: "file" | "absent" | "directory"
}

/** A path the checkpoint could not snapshot, so a restore cannot bring it back. */
export interface UnrestorableRef {
  absPath: string
  reason: "too-large" | "unreadable" | "outside-workspace"
}

/** One pre-mutation snapshot taken before the tool ran (see {@link CheckpointStore.recordSnapshot}). */
export interface PreMutationSnapshot {
  absPath: string
  before: "file" | "absent" | "directory"
  /** The file's original bytes, for `before: "file"`. */
  content?: Uint8Array
  omitted?: UnrestorableRef["reason"]
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
  /** Paths touched in this segment that a restore cannot put back. */
  unrestorable?: UnrestorableRef[]
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
  /**
   * Record a snapshot taken before the tool ran. It wins over a
   * {@link recordPreMutation} disk read of the same path, which can land after
   * the write it means to precede; the first snapshot per path still wins.
   */
  recordSnapshot(sessionId: string, snapshot: PreMutationSnapshot): void
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
  /** Paths whose ref came from a pre-run snapshot rather than a disk read. */
  snapshotted: Set<string>
  unrestorable: Map<string, UnrestorableRef>
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
    open.set(sessionId, {
      index: allocIndex(sessionId),
      refs: new Map(),
      snapshotted: new Set(),
      unrestorable: new Map(),
    })
  }

  const readBytes = (p: string): Uint8Array | null => {
    if (fs.readBytes) return fs.readBytes(p)
    const text = fs.read(p)
    return text == null ? null : Buffer.from(text, "utf8")
  }
  const writeBytes = (p: string, d: Uint8Array): void => {
    if (fs.writeBytes) fs.writeBytes(p, d)
    else fs.write(p, Buffer.from(d).toString("utf8"))
  }

  /** Write `bytes` as the segment's shadow of `absPath`. */
  function writeShadow(sessionId: string, seg: OpenSegment, absPath: string, bytes: Uint8Array) {
    const dir = path.join(segmentDir(home, sessionId, seg.index), "shadow")
    fs.mkdirp(dir)
    const shadowPath = path.join(dir, hashOfPath(absPath))
    writeBytes(shadowPath, bytes)
    return shadowPath
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
    if (seg.refs.has(absPath) || seg.unrestorable.has(absPath)) return // first touch wins.

    const current = readBytes(absPath)
    if (current == null) {
      // The file did not exist — restoring should delete whatever was created.
      seg.refs.set(absPath, { absPath, shadowPath: null, before: "absent" })
      return
    }
    const shadowPath = writeShadow(sessionId, seg, absPath, current)
    seg.refs.set(absPath, { absPath, shadowPath, before: "file" })
  }

  function recordSnapshot(sessionId: string, snapshot: PreMutationSnapshot): void {
    const seg = ensureSegment(sessionId)
    const { absPath } = snapshot
    if (seg.snapshotted.has(absPath)) return // the first pre-run snapshot wins.
    seg.snapshotted.add(absPath)
    seg.refs.delete(absPath)
    seg.unrestorable.delete(absPath)
    if (snapshot.omitted) {
      seg.unrestorable.set(absPath, { absPath, reason: snapshot.omitted })
      return
    }
    if (snapshot.before === "file") {
      if (!snapshot.content) {
        seg.unrestorable.set(absPath, { absPath, reason: "unreadable" })
        return
      }
      const shadowPath = writeShadow(sessionId, seg, absPath, snapshot.content)
      seg.refs.set(absPath, { absPath, shadowPath, before: "file" })
      return
    }
    seg.refs.set(absPath, { absPath, shadowPath: null, before: snapshot.before })
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
      ...(seg.unrestorable.size > 0 ? { unrestorable: [...seg.unrestorable.values()] } : {}),
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
    const kindOf = (ref: ShadowRef) => ref.before ?? (ref.shadowPath == null ? "absent" : "file")
    const byDepth = (a: ShadowRef, b: ShadowRef) => a.absPath.length - b.absPath.length
    // Removals first (whatever was created after the checkpoint, a tree
    // included), then directories parent-first, then file contents — so a
    // move or a recursive delete comes back whole.
    for (const ref of cp.files.filter((r) => kindOf(r) === "absent")) fs.rm(ref.absPath)
    for (const ref of cp.files.filter((r) => kindOf(r) === "directory").sort(byDepth)) {
      fs.mkdirp(ref.absPath)
    }
    for (const ref of cp.files) {
      if (kindOf(ref) !== "file" || ref.shadowPath == null) continue
      const bytes = readBytes(ref.shadowPath)
      if (bytes == null) continue // shadow missing — best-effort, skip.
      writeBytes(ref.absPath, bytes)
    }
  }

  return {
    openSegment,
    recordPreMutation,
    recordSnapshot,
    commitCheckpoint,
    listCheckpoints,
    restore,
  }
}

/** Recursively collect every file path under `dir` (the {@link CheckpointFs}
 * `listDir` contract is "all descendant entries", which the store filters). */
function walkFiles(dir: string): string[] {
  let entries: nodeFs.Dirent[]
  try {
    entries = nodeFs.readdirSync(dir, { withFileTypes: true }) as nodeFs.Dirent[]
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, String(entry.name))
    if (entry.isDirectory()) out.push(...walkFiles(full))
    else out.push(full)
  }
  return out
}

/** Production {@link CheckpointFs} backed by node's synchronous fs. */
export const realCheckpointFs: CheckpointFs = {
  read: (p) => {
    try {
      return nodeFs.readFileSync(p, "utf8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
      throw err
    }
  },
  write: (p, d) => {
    nodeFs.mkdirSync(path.dirname(p), { recursive: true })
    nodeFs.writeFileSync(p, d)
  },
  readBytes: (p) => {
    try {
      return nodeFs.readFileSync(p)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
      throw err
    }
  },
  writeBytes: (p, d) => {
    nodeFs.mkdirSync(path.dirname(p), { recursive: true })
    nodeFs.writeFileSync(p, d)
  },
  rm: (p) => {
    try {
      nodeFs.rmSync(p, { force: true, recursive: true })
    } catch {
      // best-effort delete
    }
  },
  exists: (p) => nodeFs.existsSync(p),
  mkdirp: (p) => nodeFs.mkdirSync(p, { recursive: true }),
  listDir: (p) => walkFiles(p),
}
