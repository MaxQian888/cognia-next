/**
 * The plugin contract's share of `lib/files/types.ts`, which re-exports these.
 */
export interface WorkspaceEntry {
  /** Path relative to the search root, normalised to forward slashes. */
  relPath: string
  absolutePath: string
  isDir: boolean
  size: number
  /** Last-modified time in ms since epoch, or `null` when unavailable. */
  mtimeMs: number | null
}
