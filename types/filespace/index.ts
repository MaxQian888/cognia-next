/**
 * A conversation's FileSpace (ADR-0222): the virtual namespace of one
 * conversation, derived on demand from bindings that already exist — the
 * execution leases (ADR-0111), the workspace roots (ADR-0144), the session's
 * uploads and its artifacts. Nothing here is persisted as a row of its own:
 * a stored copy would be a second answer to "which directories belong to this
 * conversation", which `resolveSessionExecutionRoot` already owns.
 *
 * Types only. The resolver is `lib/filespace/resolve.ts`.
 */

/**
 * Stable mount identifiers. `root:<id>` carries the logical root id of an
 * additional execution lease, or the workspace root id when the conversation
 * has no execution binding yet.
 */
export type FileSpaceMountId = "workspace" | `root:${string}` | "uploads" | "artifacts"

/** Where a mount's bytes live. Disk mounts have a host path; Dexie mounts do not. */
export type FileSpaceMountBacking = "disk" | "dexie"

export type FileSpaceMountStatus = "available" | "offline" | "missing" | "deleted"

/**
 * Why a mount is not `available`. Rendered as-is by the Files panel; never
 * inferred from the absence of a reason.
 *
 * - `no-fs-backend` — pure web/mobile with no desktop or companion host: disk
 *   mounts cannot be read from here.
 * - `host-offline` — the conversation runs on a remote host whose transport is
 *   down.
 * - `managed-missing-on-device` — the managed workspace exists on another
 *   device and was never materialized on this one.
 * - `managed-deleted` — the managed workspace directory was deleted.
 */
export type FileSpaceMountStatusReason =
  "no-fs-backend" | "host-offline" | "managed-missing-on-device" | "managed-deleted"

export interface FileSpaceMount {
  id: FileSpaceMountId
  /** Stable virtual prefix: `/workspace`, `/roots/<id>`, `/uploads`, `/artifacts`. */
  virtualPath: string
  backing: FileSpaceMountBacking
  /** Display label: the root's label or directory name for disk mounts. */
  label: string
  /**
   * Absolute host directory. Present on a disk mount whenever the directory is
   * known (`available` or `offline`); absent on a managed workspace that is
   * missing on this device or deleted, and on every Dexie mount.
   */
  hostPath?: string
  /**
   * The same directory as a Docker sandbox connection bound to this
   * conversation sees it (`workspaceMount`), when the connection maps it.
   */
  containerPath?: string
  /**
   * True when `hostPath` is a managed worktree or shadow rather than the user's
   * own checkout. A file list that silently shows a worktree copy is how people
   * edit the wrong tree.
   */
  managed: boolean
  /** Disk mounts only. */
  role?: "primary" | "additional"
  /** Disk mounts only: the execution lease's logical root id, or the workspace root id. */
  logicalRootId?: string
  /** Dexie mounts are always read-only. */
  writable: boolean
  status: FileSpaceMountStatus
  statusReason?: FileSpaceMountStatusReason
}

export type ConversationFileSpaceStatus = "available" | "offline" | "deleted"

export interface ConversationFileSpace {
  sessionId: string
  /**
   * `deleted` when the session is gone; `available` when any mount is;
   * `offline` otherwise (including a conversation with no mounts at all).
   */
  status: ConversationFileSpaceStatus
  mounts: FileSpaceMount[]
  /**
   * The host that owns the disk mounts: `"local"` for this machine, or the
   * active remote host's id when execution is routed to one (ADR-0082).
   */
  hostId: string
  /** Display label for `hostId`. Absent for `"local"`. */
  hostLabel?: string
}

/**
 * A path inside a FileSpace, e.g. `/workspace/src/a.ts`. Always POSIX,
 * absolute, NFC-normalized, with no `.`/`..`/empty segments. Only
 * `normalizeFileSpacePath` mints one.
 */
export type FileSpacePath = string & { readonly __brand: "FileSpacePath" }

/** One row inside a Dexie-backed mount. */
export interface FileSpaceDexieEntry {
  mountId: "uploads" | "artifacts"
  /** Unique within the mount; the disambiguated form when names collide. */
  path: FileSpacePath
  name: string
  size: number
  mediaType: string
  /** Creation time; orders same-named rows for bare-name lookups. */
  createdAt: number
  updatedAt: number
  /** The row it projects: a session asset id or an artifact id. */
  sourceId: string
  /** Uploads only: false when the metadata survived but the bytes did not. */
  sourceAvailable: boolean
}

/** Where a FileSpace path lands. */
export type FileSpaceLocation =
  | { kind: "disk"; mount: FileSpaceMount; relPath: string }
  | { kind: "dexie"; mount: FileSpaceMount; entry: FileSpaceDexieEntry | null }

/** Outcome of opening a FileSpace path in the UI. */
export type OpenFileSpacePathResult =
  "opened" | "not-found" | "outside" | "no-backend" | "offline" | "session-changed"
