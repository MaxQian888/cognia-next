// Fixture builders for Source Control stories. Spread `over` to vary a single
// field; every required field gets a realistic default so the object satisfies
// the `@/types/git` wire shapes and is valid to seed into the git store via
// `seedStore` or pass as a prop.
import { fn } from "storybook/test"
import type {
  GitBranch,
  GitCommit,
  GitConflict,
  GitDiff,
  GitFileChange,
  GitFileStatus,
  GitHunk,
  GitRef,
  GitStashEntry,
  GitStatus,
  GitStatusGroup,
} from "@/types/git"
import type { UseGitActionsResult } from "@/hooks/git/use-git-actions"

/**
 * A complete `UseGitActionsResult` whose every mutation is a Storybook `fn()`
 * spy — components take `Pick<>` subsets of this, so one builder serves all of
 * them and every click shows up in the Actions panel.
 */
export function makeGitActions(): UseGitActionsResult {
  const keys = [
    "stage",
    "unstage",
    "discard",
    "discardAll",
    "commit",
    "checkout",
    "createBranch",
    "deleteBranch",
    "renameBranch",
    "fetch",
    "pull",
    "push",
    "sync",
    "stashPush",
    "stashPop",
    "stashApply",
    "stashDrop",
    "resolveConflict",
    "merge",
    "ignoreAdd",
    "mergeAbort",
    "remoteAdd",
    "remoteRemove",
    "createTag",
    "deleteTag",
    "pushTag",
    "reset",
    "restore",
    "rebase",
    "cherryPick",
    "revert",
    "sequencerContinue",
    "sequencerAbort",
    "interactiveRebase",
  ] as const
  const actions = {} as Record<(typeof keys)[number], unknown>
  for (const key of keys) actions[key] = fn().mockResolvedValue(undefined)
  return actions as unknown as UseGitActionsResult
}

export function makeChange(
  status: GitFileStatus,
  over: Partial<GitFileChange> = {}
): GitFileChange {
  return {
    path: "src/components/chat/composer.tsx",
    origPath: null,
    status,
    staged: false,
    group: "changes" as GitStatusGroup,
    ...over,
  }
}

/** A non-empty, mixed working tree: merge conflicts + staged + unstaged. */
export function makeDirtyStatus(over: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: "feature/source-control",
    upstream: "origin/feature/source-control",
    ahead: 2,
    behind: 1,
    staged: [
      makeChange("added", { path: "lib/git/commands.ts", staged: true, group: "staged" }),
      makeChange("modified", { path: "stores/git/git-store.ts", staged: true, group: "staged" }),
    ],
    changes: [
      makeChange("modified", { path: "components/source-control/diff-pane.tsx" }),
      makeChange("untracked", { path: "components/source-control/notes.md" }),
      makeChange("deleted", { path: "components/source-control/old-widget.tsx" }),
      makeChange("renamed", {
        path: "components/source-control/branch-header.tsx",
        origPath: "components/source-control/branch-chip.tsx",
      }),
    ],
    merge: [
      makeChange("conflicted", {
        path: "i18n/messages/en.json",
        group: "merge",
      }),
    ],
    isRebasing: false,
    isMerging: true,
    ...over,
  }
}

/** A clean working tree on a tracked branch with no divergence. */
export function makeCleanStatus(over: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: "main",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    staged: [],
    changes: [],
    merge: [],
    isRebasing: false,
    isMerging: false,
    ...over,
  }
}

export function makeBranch(name: string, over: Partial<GitBranch> = {}): GitBranch {
  return {
    name,
    isCurrent: false,
    isRemote: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    ...over,
  }
}

export function makeStash(index: number, over: Partial<GitStashEntry> = {}): GitStashEntry {
  return {
    index,
    message: `WIP on main: refactor source-control panel ${index}`,
    branch: "main",
    ...over,
  }
}

let commitSeq = 0
const AUTHORS = ["Ada Lovelace", "Grace Hopper", "Alan Turing"]

export function makeCommit(over: Partial<GitCommit> = {}): GitCommit {
  commitSeq += 1
  const hash = `${commitSeq.toString(16).padStart(2, "0")}${"abc123def456abc789".repeat(2)}`.slice(
    0,
    40
  )
  return {
    hash,
    shortHash: hash.slice(0, 7),
    summary: `feat(source-control): commit number ${commitSeq}`,
    body: "",
    authorName: AUTHORS[commitSeq % AUTHORS.length],
    authorEmail: "dev@example.com",
    authoredAtMs: Date.UTC(2026, 5, 20, 9, 0, 0) - commitSeq * 3_600_000,
    parents: [],
    ...over,
  }
}

/** A linear-ish history whose parents chain so the lane layout has edges. */
export function makeHistory(count = 8): GitCommit[] {
  const commits: GitCommit[] = []
  for (let i = 0; i < count; i++) {
    const commit = makeCommit({
      summary:
        i === 3
          ? "Merge branch 'feature/diff-viewer' into main"
          : `feat: history entry ${count - i}`,
      body: i === 0 ? "Adds the commit-graph lane layout engine.\n\nWith a second paragraph." : "",
    })
    if (i > 0) commit.parents = [commits[i - 1].hash]
    if (i === 3) commit.parents = [commits[2].hash, commits[1].hash]
    commits.push(commit)
  }
  return commits
}

export function makeRef(name: string, over: Partial<GitRef> = {}): GitRef {
  return {
    name,
    kind: "branch",
    targetHash: "0".repeat(40),
    ...over,
  }
}

const OLD_SOURCE = `export function greet(name) {
  return "Hi " + name
}

const x = 1
const y = 2
`

const NEW_SOURCE = `export function greet(name: string): string {
  return \`Hello, \${name}!\`
}

const x = 1
const y = 3
const z = 4
`

export function makeHunk(over: Partial<GitHunk> = {}): GitHunk {
  return {
    header: "@@ -1,5 +1,7 @@",
    oldStart: 1,
    oldLines: 5,
    newStart: 1,
    newLines: 7,
    patch:
      '@@ -1,5 +1,7 @@\n-export function greet(name) {\n-  return "Hi " + name\n+export function greet(name: string): string {\n+  return `Hello, ${name}!`\n }\n',
    lines: [
      { kind: "del", content: "export function greet(name) {" },
      { kind: "add", content: "export function greet(name: string): string {" },
      { kind: "context", content: "}" },
    ],
    ...over,
  }
}

export function makeDiff(over: Partial<GitDiff> = {}): GitDiff {
  return {
    path: "src/lib/greet.ts",
    oldContent: OLD_SOURCE,
    newContent: NEW_SOURCE,
    hunks: [makeHunk()],
    isBinary: false,
    language: "typescript",
    ...over,
  }
}

export function makeConflict(over: Partial<GitConflict> = {}): GitConflict {
  return {
    path: "i18n/messages/en.json",
    ours: `{
  "sourceControl": {
    "title": "Source Control",
    "commit": "Commit"
  }
}
`,
    theirs: `{
  "sourceControl": {
    "title": "Version Control",
    "commit": "Create commit"
  }
}
`,
    base: `{
  "sourceControl": {
    "title": "Source Control"
  }
}
`,
    ...over,
  }
}
