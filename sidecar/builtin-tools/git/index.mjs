// Assembler for the `git` builtin category — structured wrappers around the
// `git` CLI.
//
// Tools are emitted in the FIXED order of GIT_TOOL_NAMES (prompt-cache
// stability). New tools are APPENDED. Most tools are read-only; git_stage and
// git_commit are WRITE and route through the permission resolver.

import { gitStatusTool, execGitStatus } from "./status.mjs"
import { gitDiffTool, execGitDiff } from "./diff.mjs"
import { gitLogTool, gitHistoryTool, execGitLog, execGitHistory } from "./log.mjs"
import {
  gitBranchTool,
  gitRemoteTool,
  gitTagTool,
  execGitBranch,
  execGitRemote,
  execGitTag,
} from "./refs.mjs"
import {
  gitRepoInspectTool,
  gitChangesTool,
  execGitRepoInspect,
  execGitChanges,
} from "./inspect.mjs"
import { gitStageTool, gitCommitTool, execGitStage, execGitCommit } from "./write.mjs"
import { runGit, assertRepo, trimTail } from "./run.mjs"

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
  if (gitTools[i].name !== GIT_TOOL_NAMES[i]) {
    throw new Error(`git tool order drift: expected ${GIT_TOOL_NAMES[i]}, got ${gitTools[i].name}`)
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
