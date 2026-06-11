/**
 * File-IO subsystem types.
 *
 * These describe the permission policy, access decisions, file metadata, and
 * audit records used by the secure file-IO layer (`lib/files/`). They live in
 * `types/` — like `types/logging` and `types/workspace` — so any layer (hooks,
 * components, plugin bridge) can reference them without importing runtime code.
 */

/** A file-system operation the permission layer can gate. */
export type FileOperation =
  | "read"
  | "write"
  | "delete"
  | "copy"
  | "move"
  | "list"
  | "stat"
  | "mkdir"

/**
 * Operations that mutate the filesystem. A read-only policy denies all of
 * these. Exported as a runtime-friendly tuple type so `lib/files` can derive
 * the matching `Set` without duplicating the list.
 */
export type MutatingFileOperation = "write" | "delete" | "copy" | "move" | "mkdir"

/** Machine-stable reason codes for an access decision. */
export type FileDenyReason =
  | "empty_path"
  | "no_roots"
  | "outside_roots"
  | "traversal"
  | "read_only"
  | "denied_glob"
  | "too_large"

/**
 * Describes what a holder of this policy may do on the filesystem. Built from
 * the active workspace roots (see `defaultFilePolicy`) but can be hand-rolled
 * for narrower scopes (a single plugin sandbox dir, a read-only export root).
 */
export interface FileAccessPolicy {
  /**
   * Absolute directory roots access is confined to. A target path is allowed
   * only when it resolves inside one of these roots (unless `allowAnyPath`).
   */
  allowedRoots: string[]
  /** When true, every mutating operation is denied even inside an allowed root. */
  readOnly?: boolean
  /**
   * Case-insensitive, segment-aware deny globs (see `lib/files/glob-match.ts`).
   * A bare token (`.env`, `id_rsa`) matches a whole path *segment* equal to it
   * (never a longer segment that merely contains it); `*` matches within a
   * segment, `**` matches zero+ segments (e.g. `**​/.git/**`, `*.pem`,
   * `secrets/**`). Matched against the path *relative to its allowed root*.
   */
  deniedGlobs?: string[]
  /** Reject read/write payloads larger than this many bytes. */
  maxBytes?: number
  /**
   * Escape hatch that disables root containment — the path-traversal guard
   * still runs. Off by default; only set for trusted, user-gesture-gated flows.
   */
  allowAnyPath?: boolean
}

/** The verdict from `checkFileAccess`. */
export interface FileAccessDecision {
  allowed: boolean
  /** `"ok"` when allowed, otherwise the machine-stable deny reason. */
  reason: FileDenyReason | "ok"
  /** Human-readable detail, surfaced in logs and audit entries. */
  detail?: string
  /** The allowed root the target resolved inside, when applicable. */
  matchedRoot?: string
}

/** Cross-runtime file metadata, normalized from the Tauri / web backends. */
export interface FileStat {
  path: string
  size: number
  isFile: boolean
  isDir: boolean
  isSymlink?: boolean
  /** Last-modified epoch ms, when the runtime exposes it. */
  modifiedMs?: number
  /** Creation epoch ms, when available. */
  createdMs?: number
  /** True when the file is not writable (best-effort; runtime-dependent). */
  readonly?: boolean
}

/** One recorded file operation, kept in the in-memory audit ring buffer. */
export interface FileAuditEntry {
  /** Stable id for de-duplication in the ring buffer. */
  id: string
  op: FileOperation
  path: string
  /** Destination path for `copy` / `move`. */
  destPath?: string
  allowed: boolean
  /** Bytes read or written, when the operation moves data. */
  bytes?: number
  /** Wall-clock duration of the underlying runtime call. */
  durationMs?: number
  /** Deny reason or thrown runtime error message; absent on success. */
  error?: string
  /** Epoch ms when the operation was recorded. */
  ts: number
}
