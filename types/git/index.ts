/**
 * Wire types for the Source Control seam — mirror the Rust DTOs in
 * `src-tauri/src/git/types.rs` 1:1 (serde `camelCase`).
 */

export type GitFileStatus =
  "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted" | "typeChanged"

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

export interface GitFileDiffStat {
  /** Final repo-relative path, forward slashes. */
  path: string
  insertions: number
  deletions: number
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

/**
 * One entry from `git worktree list --porcelain`. Used by the agent-team
 * per-dispatch isolation layer; agent worktrees carry a branch named
 * `agent/<runId>/<teammate>/<taskId>`.
 */
export interface GitWorktree {
  path: string
  branch: string | null
  head: string | null
  locked: boolean
  lockReason: string | null
  prunable: boolean
  pruneReason: string | null
  isMain: boolean
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

export interface GitIdentity {
  name: string | null
  email: string | null
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

/** Interactive-rebase action for a commit (mirrors git's todo verbs). */
export type RebaseAction = "pick" | "reword" | "squash" | "fixup" | "drop"

/** One row of an interactive-rebase plan, in final (top→bottom) order. */
export interface RebaseTodoEntry {
  sha: string
  action: RebaseAction
  /** New message for `reword` (collected up-front in the dialog). */
  message?: string
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
  | "identityRequired"
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

/**
 * Shared shape for the diff-oriented AI features (per-hunk review, change
 * explanation). Mirrors {@link GitCommitAiSettings} minus the commit-only
 * `conventionalCommits` knob.
 */
export interface GitAiFeatureSettings {
  /** Master toggle — when false the feature's entry button is hidden. */
  enabled: boolean
  /** Optional extra steering appended to the system prompt. */
  customInstructions?: string
  /** Provider/model override (mirrors `UtilityModelConfig`). Empty → chat default. */
  providerOverride?: string
  model?: string
}

/** Severity of an AI review finding on a single hunk. */
export type HunkFindingSeverity = "info" | "warning" | "critical"

/** An AI review note attached to one hunk (persisted advisory, not a git effect). */
export interface HunkAiFinding {
  severity: HunkFindingSeverity
  note: string
}

/** Source Control feature preferences persisted on `AppSettings.gitSettings`. */
export interface GitUiSettings {
  commitMessageAI: GitCommitAiSettings
  /** AI per-hunk code review of a working-tree file diff. */
  reviewAI?: GitAiFeatureSettings
  /** AI natural-language explanation of a file/commit diff. */
  explainAI?: GitAiFeatureSettings
  /**
   * Panel view/workflow preferences. Stored as an all-optional partial and
   * resolved at read time by `resolveSourceControlPanelPrefs` (leaf module —
   * imported type-only to avoid a cycle), so older installs pick up new fields
   * without a Dexie migration.
   */
  panel?: import("@/lib/git/panel-prefs").PartialSourceControlPanelPrefs
}

/** Forward-compat defaults merged by `lib/db/settings.ts:getSettings()`. */
export const DEFAULT_GIT_SETTINGS: GitUiSettings = {
  commitMessageAI: {
    enabled: false,
    conventionalCommits: true,
  },
  reviewAI: {
    enabled: false,
  },
  explainAI: {
    enabled: false,
  },
}

/**
 * How a repository's trunk was determined.
 *
 * Kept because "the remote told us" and "we guessed" are different facts, and a
 * caller that roots a stack on the answer needs to tell them apart.
 */
export type GitDefaultBranchSource = "remoteHead" | "remoteBranch" | "localBranch" | "guess"

export const GIT_DEFAULT_BRANCH_SOURCES = [
  "remoteHead",
  "remoteBranch",
  "localBranch",
  "guess",
] as const satisfies readonly GitDefaultBranchSource[]

/** A repository's trunk, and how sure the backend is of it. */
export interface GitDefaultBranch {
  /** Short name, e.g. `main` — never `origin/main`. */
  branch: string
  source: GitDefaultBranchSource
  /** Whether the name resolves to a commit, locally or as a tracking ref. */
  exists: boolean
}

// ── Stacked branches (crates/cognia-git/src/stack.rs) ──────────────────────

/** What this machine's git can do, probed rather than assumed from a version. */
export interface GitStackCapabilities {
  /** `git --version`, verbatim. */
  version: string
  /** `git replay` exists — restacking can leave every working tree alone. */
  replay: boolean
  /**
   * `git replay` takes `--ref-action`, which means its default is to write refs
   * itself. Surfaced because the difference is not cosmetic: under that default
   * `--contained` moves every branch inside the replayed range.
   */
  replayRefAction: boolean
  /** `push --force-if-includes` exists — a lease a background fetch cannot satisfy. */
  forceIfIncludes: boolean
}

/** One layer of a stack, as git reports it rather than as anyone recorded it. */
export interface GitStackLayerState {
  branch: string
  /** The recorded parent, or null for the bottom layer. */
  parent: string | null
  /** Resolved tip, or null when the branch does not exist. */
  head: string | null
  /**
   * Whether the parent is actually an ancestor of this branch. False means the
   * layer is behind: publishing it produces a pull request whose diff includes
   * its parent's work.
   */
  containsParent: boolean
  /**
   * Worktree this branch is checked out in, when it is one. A restack moves the
   * ref without moving files, so such a layer is refused rather than left
   * disagreeing with its own HEAD.
   */
  checkedOutIn: string | null
}

export type GitRestackMethod = "replay" | "rebase"

export interface GitStackRefUpdate {
  branch: string
  from: string
  to: string
  /** Where the previous tip was pinned, so the move can be undone. */
  historyRef: string
}

export interface GitStackConflict {
  branch: string
  /** Scratch worktree the rebase stopped in — the only place to resolve it. */
  worktree: string
}

export interface GitRestackOutcome {
  method: GitRestackMethod
  updates: GitStackRefUpdate[]
  conflict: GitStackConflict | null
}

export interface GitStackPushOutcome {
  pushed: string[]
  /** False when this git could only offer the weaker `--force-with-lease`. */
  forceIfIncludes: boolean
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
