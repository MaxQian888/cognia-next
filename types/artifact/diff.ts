/**
 * Diff-related type definitions for artifact version comparison
 */

export type DiffLineType = "added" | "removed" | "unchanged"

export interface DiffLine {
  type: DiffLineType
  content: string
  oldLineNum?: number
  newLineNum?: number
}

export interface DiffStats {
  added: number
  removed: number
}
