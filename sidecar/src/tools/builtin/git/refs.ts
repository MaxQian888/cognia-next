// git_branch + git_remote + git_tag — ref listings (read-only).

import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"

import type { ToolArgs } from "../../kernel/define.ts"
import { toolError, toolText } from "../../kernel/result.ts"
import { runGit } from "../../../platform/process/git.ts"
import { assertRepo } from "./run.ts"

// ---- git_branch -----------------------------------------------------------

const gitBranchShape = {
  cwd: z.string().min(1).describe("Absolute path inside the git repo."),
  remote: z.boolean().default(false).describe("Include remote-tracking branches."),
}

async function execGitBranch(args: ToolArgs<typeof gitBranchShape>) {
  try {
    await assertRepo(args.cwd)
    const argv = ["branch", "-vv"]
    if (args.remote) argv.push("-a")
    const { stdout } = await runGit(argv, args.cwd)
    return toolText(stdout || "(no branches)")
  } catch (err) {
    return toolError(err, "git_branch")
  }
}

export const gitBranchTool = tool(
  "git_branch",
  "List local (and optionally remote) branches with their tracking info.",
  gitBranchShape,
  execGitBranch
)

// ---- git_remote -----------------------------------------------------------

const gitRemoteShape = {
  cwd: z.string().min(1).describe("Absolute path inside the git repo."),
}

async function execGitRemote(args: ToolArgs<typeof gitRemoteShape>) {
  try {
    await assertRepo(args.cwd)
    const { stdout } = await runGit(["remote", "-v"], args.cwd)
    return toolText(stdout || "(no remotes)")
  } catch (err) {
    return toolError(err, "git_remote")
  }
}

export const gitRemoteTool = tool(
  "git_remote",
  "List remotes with their fetch/push URLs.",
  gitRemoteShape,
  execGitRemote
)

// ---- git_tag --------------------------------------------------------------

const gitTagShape = {
  cwd: z.string().min(1).describe("Absolute path inside the git repo."),
  pattern: z.string().optional().describe("Optional tag glob pattern (e.g. 'v*')."),
}

async function execGitTag(args: ToolArgs<typeof gitTagShape>) {
  try {
    await assertRepo(args.cwd)
    const argv = ["tag", "--list"]
    if (args.pattern) argv.push(args.pattern)
    const { stdout } = await runGit(argv, args.cwd)
    return toolText(stdout || "(no tags)")
  } catch (err) {
    return toolError(err, "git_tag")
  }
}

export const gitTagTool = tool(
  "git_tag",
  "List tags, optionally filtered by glob pattern.",
  gitTagShape,
  execGitTag
)

export { execGitBranch, execGitRemote, execGitTag }
