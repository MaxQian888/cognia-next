/**
 * Workspace root model. A workspace (the `Project` entity) mounts one or more
 * on-disk directories. Exactly one root is the primary (the cwd); the others
 * forward to the SDK as additionalDirectories.
 */
export interface WorkspaceRoot {
  /** Stable id, `root-${nanoid()}`. */
  id: string
  /** Absolute directory path. */
  path: string
  /** Display name; UI falls back to the basename of `path` when absent. */
  label?: string
  /** Exactly one root in a workspace is primary (used as the cwd). */
  isPrimary?: boolean
}

/** Per-root trust verdict, derived at read time — never persisted on Project. */
export type WorkspaceTrustState = "trusted" | "untrusted" | "unknown"
