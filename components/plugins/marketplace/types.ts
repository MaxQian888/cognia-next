/**
 * Type contracts shared between marketplace components and the
 * marketplace store. These are pure type aliases — components and the
 * store import them; mutating any of them is a breaking change to
 * persisted state.
 */

export type SortOption = "relevance" | "popular" | "newest" | "updated" | "name" | "rating"

export type CategoryFilter =
  | "all"
  | "tools"
  | "themes"
  | "providers"
  | "skills"
  | "modes"
  | "exporters"
  | "processors"
  | "components"

export type QuickFilter =
  "all" | "trending" | "featured" | "new" | "verified" | "free" | "installed"

export type InstallStage =
  | "idle"
  | "queued"
  | "downloading"
  | "verifying"
  | "extracting"
  | "registering"
  | "activating"
  | "complete"
  | "done"
  | "error"

export interface InstallProgressInfo {
  stage: InstallStage
  /** 0..1 — undefined when the stage isn't measurable. */
  progress?: number
  /** Free-form status message shown under the progress bar. */
  message?: string
  /** Bytes downloaded / total — only set during `downloading`. */
  bytesLoaded?: number
  bytesTotal?: number
  error?: string
}
