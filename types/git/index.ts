/**
 * Wire types for the Source Control seam — mirror the Rust DTOs in
 * `src-tauri/src/git/types.rs` 1:1 (serde `camelCase`).
 */

export type GitFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflicted"
  | "typeChanged"

export type GitStatusGroup = "staged" | "changes" | "merge"

export interface GitFileChange {
  /** Repo-relative path, forward slashes. */
  path: string
  /** Original path for renames; `null` otherwise. */
  origPath: string | null
  status: GitFileStatus
  staged: boolean
  group: GitStatusGroup
}

export interface GitStatus {
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  staged: GitFileChange[]
  changes: GitFileChange[]
  merge: GitFileChange[]
  isRebasing: boolean
  isMerging: boolean
}

export interface GitDiffLine {
  /** `"context"` | `"add"` | `"del"`. */
  kind: string
  content: string
}

export interface GitHunk {
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** Self-contained unified patch (file header + this `@@` block). */
  patch: string
  lines: GitDiffLine[]
}

export interface GitDiff {
  path: string
  oldContent: string
  newContent: string
  hunks: GitHunk[]
  isBinary: boolean
  /** Resolved client-side from the path extension (not sent by Rust). */
  language?: string | null
}

export interface GitBranch {
  name: string
  isCurrent: boolean
  isRemote: boolean
  upstream: string | null
  ahead: number
  behind: number
}

export interface GitStashEntry {
  index: number
  message: string
  branch: string | null
}

export interface GitConflict {
  path: string
  ours: string
  theirs: string
  base: string | null
}

export interface GitCommit {
  hash: string
  shortHash: string
  summary: string
  body: string
  authorName: string
  authorEmail: string
  authoredAtMs: number
  parents: string[]
}

export interface GitRemote {
  name: string
  fetchUrl: string
  pushUrl: string
}

export interface GitTag {
  name: string
  targetHash: string
  message: string | null
  isAnnotated: boolean
}

/** Reset modes mirroring `git reset --soft|--mixed|--hard`. */
export type GitResetMode = "soft" | "mixed" | "hard"

export type GitRefKind = "branch" | "remoteBranch" | "tag" | "head"

export interface GitRef {
  name: string
  kind: GitRefKind
  /** Commit the ref points at (annotated tags / symbolic refs peeled). */
  targetHash: string
}

// ---------------------------------------------------------- commit graph

/** A line segment crossing one graph row's vertical band. */
export interface GraphEdge {
  /** Lane the segment occupies at the top of the row's cell. */
  fromLane: number
  /** Lane the segment occupies at the bottom of the row's cell. */
  toLane: number
  /** Palette color index (`lane % paletteLength`). */
  color: number
}

/** One rendered row: the commit, its node lane/color, edges, and ref badges. */
export interface GraphRow {
  commit: GitCommit
  /** Lane the commit's node sits in. */
  lane: number
  /** Node color = palette index for its lane. */
  color: number
  /** Segments passing through this row's cell band (to the next row). */
  edges: GraphEdge[]
  /** Refs pointing at this commit. */
  refs: GitRef[]
}

export interface CommitGraphLayout {
  rows: GraphRow[]
  /** Max simultaneous lanes — drives the SVG cell width. */
  laneCount: number
}

/** One blamed line: which commit last touched it, author, time, and content. */
export interface GitBlameLine {
  lineNumber: number
  commitHash: string
  shortHash: string
  authorName: string
  authoredAtMs: number
  summary: string
  content: string
}

export type GitOperationKind = "merge" | "rebase" | "cherryPick" | "revert"

export interface GitRepoState {
  isRepo: boolean
  rootDir: string | null
  detachedHead: boolean
  operationInProgress: GitOperationKind | null
}

export interface AheadBehind {
  ahead: number
  behind: number
}

export type ConflictSide = "ours" | "theirs"

/** Distinct failure kinds the Rust `GitError` serializes as `{ kind, detail }`. */
export type GitErrorKind =
  | "notARepo"
  | "notFound"
  | "dirtyWorkingTree"
  | "mergeConflict"
  | "authRequired"
  | "networkFailed"
  | "patchFailed"
  | "lockHeld"
  | "gitNotInstalled"
  | "libgit2"
  | "commandFailed"
  | "invalidArgument"

export interface GitErrorPayload {
  kind: GitErrorKind
  detail?: string
}

/** Frozen inert status for the web/mobile (non-Tauri) fallback. */
export const EMPTY_STATUS: GitStatus = Object.freeze({
  branch: null,
  upstream: null,
  ahead: 0,
  behind: 0,
  staged: [],
  changes: [],
  merge: [],
  isRebasing: false,
  isMerging: false,
}) as GitStatus

export const EMPTY_REPO_STATE: GitRepoState = Object.freeze({
  isRepo: false,
  rootDir: null,
  detachedHead: false,
  operationInProgress: null,
}) as GitRepoState

// --------------------------------------------------------------- UI settings

/** AI commit-message generation preferences (under `AppSettings.gitSettings`). */
export interface GitCommitAiSettings {
  /** Master toggle — when false the Sparkles button is hidden. */
  enabled: boolean
  /** Constrain the generated message to the Conventional Commits format. */
  conventionalCommits: boolean
  /** Optional extra steering appended to the system prompt. */
  customInstructions?: string
  /**
   * Provider/model override for generation (mirrors `UtilityModelConfig`).
   * Empty → falls back to the chat default model. Kept as flat fields so this
   * type stays free of a `lib/` dependency.
   */
  providerOverride?: string
  model?: string
}

/** Source Control feature preferences persisted on `AppSettings.gitSettings`. */
export interface GitUiSettings {
  commitMessageAI: GitCommitAiSettings
}

/** Forward-compat defaults merged by `lib/db/settings.ts:getSettings()`. */
export const DEFAULT_GIT_SETTINGS: GitUiSettings = {
  commitMessageAI: {
    enabled: false,
    conventionalCommits: true,
  },
}

/** Cache key for a working-tree / staged file diff. */
export function fileDiffKey(path: string, staged: boolean): string {
  return `${staged ? "s" : "w"}:${path}`
}

/** Cache key for a commit's per-file diff (Timeline). */
export function commitDiffKey(sha: string, path: string): string {
  return `c:${sha}:${path}`
}

/** Narrow an unknown thrown value to a structured `GitErrorPayload` when possible. */
export function asGitError(err: unknown): GitErrorPayload | null {
  if (
    typeof err === "object" &&
    err !== null &&
    "kind" in err &&
    typeof (err as { kind: unknown }).kind === "string"
  ) {
    return err as GitErrorPayload
  }
  return null
}
