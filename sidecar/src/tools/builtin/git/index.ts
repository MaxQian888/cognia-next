// Assembler for the `git` builtin category — structured wrappers around the
// `git` CLI.
//
// Tools are emitted in the FIXED order of GIT_TOOL_NAMES (prompt-cache
// stability). New tools are APPENDED. Most tools are read-only; git_stage and
// git_commit are WRITE and route through the permission resolver.

import { gitStatusTool, execGitStatus } from "./status.ts"
import { gitDiffTool, execGitDiff } from "./diff.ts"
import { gitLogTool, gitHistoryTool, execGitLog, execGitHistory } from "./log.ts"
import {
  gitBranchTool,
  gitRemoteTool,
  gitTagTool,
  execGitBranch,
  execGitRemote,
  execGitTag,
} from "./refs.ts"
import {
  gitRepoInspectTool,
  gitChangesTool,
  execGitRepoInspect,
  execGitChanges,
} from "./inspect.ts"
import { gitStageTool, gitCommitTool, execGitStage, execGitCommit } from "./write.ts"
import { runGit } from "../../../platform/process/git.ts"
import { assertRepo, trimTail } from "./run.ts"

/** Fixed registration order — do not reorder (prompt-cache stability). */
export const GIT_TOOL_NAMES = Object.freeze([
  "git_status",
  "git_diff",
  "git_log",
  "git_branch",
  "git_remote",
  "git_tag",
  "git_repo_inspect",
  "git_changes",
  "git_history",
  "git_stage",
  "git_commit",
])

export const gitTools = [
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  gitBranchTool,
  gitRemoteTool,
  gitTagTool,
  gitRepoInspectTool,
  gitChangesTool,
  gitHistoryTool,
  gitStageTool,
  gitCommitTool,
]

// Defensive: the emitted order must match the public constant.
for (let i = 0; i < gitTools.length; i++) {
  if (gitTools[i]!.name !== GIT_TOOL_NAMES[i]) {
    throw new Error(`git tool order drift: expected ${GIT_TOOL_NAMES[i]}, got ${gitTools[i]!.name}`)
  }
}

export const __testExports = {
  execGitStatus,
  execGitDiff,
  execGitLog,
  execGitBranch,
  execGitRemote,
  execGitTag,
  execGitRepoInspect,
  execGitChanges,
  execGitHistory,
  execGitStage,
  execGitCommit,
  runGit,
  assertRepo,
  trimTail,
}
