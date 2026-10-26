/**
 * The plugin contract's share of `lib/files/workspace-fs.ts`, which re-exports these.
 */
import type { WorkspaceEntry } from "./types"

/** What a recursive walk found, and what it withheld. */
export interface WorkspaceWalkResult {
  entries: WorkspaceEntry[]
  /** A cap stopped the walk before the tree was exhausted. */
  truncated: boolean
  /** Files refused by the host's sensitive-name floor (`.env`, `id_rsa`, …). */
  skippedSensitive: number
}

export interface WorkspaceWalkOptions {
  relPath?: string
  includeIgnored?: boolean
  /** Include directories as well as files. Default: files only. */
  includeDirs?: boolean
  /** Entry cap. Default 5 000, hard ceiling 50 000. */
  maxEntries?: number
  /** Directory depth. Default 24. */
  maxDepth?: number
}
