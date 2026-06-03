// Git tools — structured wrappers around the `git` CLI.
//
// Each tool spawns `git` via execFile (no shell interpolation), so the args
// can never be re-parsed as shell metacharacters. The repo root is validated
// upfront via `git rev-parse --git-dir`. Output is capped to keep IPC small.
//
// Most tools are read-only. The two WRITE tools (git_stage, git_commit) are
// deliberately NOT `alwaysLoad` and carry no allow-by-default: a call routes
// through the sidecar permission resolver → renderer `permission_request`, so
// the user confirms each stage/commit (the in-chat equivalent of clicking the
// Source Control panel buttons). Network/destructive ops (push, reset, …) are
// intentionally still left to the panel / shell, not exposed here.

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"

import { toolError, toolText } from "./safety.mjs"

const execFileAsync = promisify(execFile)

const MAX_OUTPUT_BYTES = 256 * 1024 // 256 KB per command
const DEFAULT_TIMEOUT_MS = 30 * 1000

// ---- Helpers --------------------------------------------------------------

async function runGit(args, cwd, opts = {}) {
  if (!Array.isArray(args)) throw new Error("git args must be an array")
  for (const a of args) {
    if (typeof a !== "string") throw new Error("every git arg must be a string")
  }
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd,
    timeout,
    maxBuffer: MAX_OUTPUT_BYTES,
    windowsHide: true,
  })
  return { stdout: String(stdout), stderr: String(stderr) }
}

async function assertRepo(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new Error("cwd must be a non-empty absolute path")
  }
  try {
    await runGit(["rev-parse", "--git-dir"], cwd)
  } catch (err) {
    throw new Error(`not a git repository: ${cwd} (${err.message})`)
  }
}

function trimTail(s, max = MAX_OUTPUT_BYTES) {
  if (s.length <= max) return { text: s, truncated: false }
  return { text: s.slice(0, max) + "\n... (truncated)", truncated: true }
}

// ---- git_status -----------------------------------------------------------

const gitStatusShape = {
  cwd: z.string().min(1).describe("Absolute path inside the git repo."),
}

async function execGitStatus(args) {
  try {
    await assertRepo(args.cwd)
    const { stdout } = await runGit(["status", "--porcelain=v2", "--branch"], args.cwd)
    return toolText(stdout || "(clean)")
  } catch (err) {
    return toolError(err, "git_status")
  }
}

export const gitStatusTool = tool(
  "git_status",
  "Show working-tree status in porcelain v2 format. Read-only.",
  gitStatusShape,
  execGitStatus,
  { alwaysLoad: true }
)

// ---- git_diff -------------------------------------------------------------

const gitDiffShape = {
  cwd: z.string().min(1).describe("Absolute path inside the git repo."),
  staged: z
    .boolean()
    .default(false)
    .describe("Diff staged changes (--cached) instead of working tree."),
  pathspec: z.array(z.string()).optional().describe("Limit diff to these path specs."),
  context: z.number().int().min(0).max(20).default(3).describe("Context lines."),
}

async function execGitDiff(args) {
  try {
    await assertRepo(args.cwd)
    const argv = ["diff", `-U${args.context}`]
    if (args.staged) argv.push("--cached")
    if (args.pathspec?.length) argv.push("--", ...args.pathspec)
    const { stdout } = await runGit(argv, args.cwd)
    const { text, truncated } = trimTail(stdout || "(no changes)")
    return toolText(truncated ? text : stdout || "(no changes)")
  } catch (err) {
    return toolError(err, "git_diff")
  }
}

export const gitDiffTool = tool(
  "git_diff",
  "Show diff of working tree (default) or staged area (staged=true). Read-only.",
  gitDiffShape,
  execGitDiff
)

// ---- git_log --------------------------------------------------------------

const gitLogShape = {
  cwd: z.string().min(1).describe("Absolute path inside the git repo."),
  limit: z.number().int().min(1).max(500).default(20).describe("Maximum commits to return."),
  branch: z.string().optional().describe("Branch or ref to log. Defaults to HEAD."),
  pathspec: z.array(z.string()).optional().describe("Limit log to these path specs."),
}

async function execGitLog(args) {
  try {
    await assertRepo(args.cwd)
    const argv = ["log", `-n`, String(args.limit), "--pretty=format:%H%x09%an%x09%ae%x09%aI%x09%s"]
    if (args.branch) argv.push(args.branch)
    if (args.pathspec?.length) argv.push("--", ...args.pathspec)
    const { stdout } = await runGit(argv, args.cwd)
    const commits = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, author, email, isoDate, ...rest] = line.split("\t")
        return {
          hash,
          author,
          email,
          isoDate,
          subject: rest.join("\t"),
        }
      })
    return toolText({ commits, count: commits.length })
  } catch (err) {
    return toolError(err, "git_log")
  }
}

export const gitLogTool = tool(
  "git_log",
  "List recent commits with hash/author/date/subject (tab-separated, structured back as JSON).",
  gitLogShape,
  execGitLog
)

// ---- git_branch -----------------------------------------------------------

const gitBranchShape = {
  cwd: z.string().min(1).describe("Absolute path inside the git repo."),
  remote: z.boolean().default(false).describe("Include remote-tracking branches."),
}

async function execGitBranch(args) {
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

async function execGitRemote(args) {
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

async function execGitTag(args) {
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

// ---- git_repo_inspect -----------------------------------------------------

const gitRepoInspectShape = {
  cwd: z.string().min(1).describe("Absolute path inside the git repo."),
}

async function execGitRepoInspect(args) {
  try {
    await assertRepo(args.cwd)
    const [topLevel, headRef, headHash, upstream] = await Promise.all([
      runGit(["rev-parse", "--show-toplevel"], args.cwd).then((r) => r.stdout.trim()),
      runGit(["symbolic-ref", "--short", "HEAD"], args.cwd)
        .then((r) => r.stdout.trim())
        .catch(() => null),
      runGit(["rev-parse", "HEAD"], args.cwd)
        .then((r) => r.stdout.trim())
        .catch(() => null),
      runGit(["rev-parse", "--abbrev-ref", "@{upstream}"], args.cwd)
        .then((r) => r.stdout.trim())
        .catch(() => null),
    ])
    return toolText({ topLevel, headRef, headHash, upstream })
  } catch (err) {
    return toolError(err, "git_repo_inspect")
  }
}

export const gitRepoInspectTool = tool(
  "git_repo_inspect",
  "Return repo top-level, current branch, HEAD hash, and upstream tracking info.",
  gitRepoInspectShape,
  execGitRepoInspect
)

// ---- git_changes ----------------------------------------------------------

const gitChangesShape = {
  cwd: z.string().min(1).describe("Absolute path inside the git repo."),
}

async function execGitChanges(args) {
  try {
    await assertRepo(args.cwd)
    const { stdout } = await runGit(["status", "--porcelain"], args.cwd)
    const entries = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const status = line.slice(0, 2)
        const file = line.slice(3)
        return { status, file }
      })
    return toolText({ count: entries.length, entries })
  } catch (err) {
    return toolError(err, "git_changes")
  }
}

export const gitChangesTool = tool(
  "git_changes",
  "List changed files in the working tree (porcelain v1, structured as JSON).",
  gitChangesShape,
  execGitChanges
)

// ---- git_history ----------------------------------------------------------

const gitHistoryShape = {
  cwd: z.string().min(1).describe("Absolute path inside the git repo."),
  pathspec: z.array(z.string()).min(1).describe("Files/paths to inspect history for."),
  limit: z.number().int().min(1).max(200).default(10).describe("Max commits returned."),
}

async function execGitHistory(args) {
  try {
    await assertRepo(args.cwd)
    const argv = [
      "log",
      `-n`,
      String(args.limit),
      "--pretty=format:%H%x09%an%x09%aI%x09%s",
      "--",
      ...args.pathspec,
    ]
    const { stdout } = await runGit(argv, args.cwd)
    const commits = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, author, isoDate, ...rest] = line.split("\t")
        return { hash, author, isoDate, subject: rest.join("\t") }
      })
    return toolText({ commits, count: commits.length, pathspec: args.pathspec })
  } catch (err) {
    return toolError(err, "git_history")
  }
}

export const gitHistoryTool = tool(
  "git_history",
  "Show commit history for one or more file paths.",
  gitHistoryShape,
  execGitHistory
)

// ---- git_stage (WRITE) ----------------------------------------------------

const gitStageShape = {
  cwd: z.string().min(1).describe("Absolute path inside the git repo."),
  paths: z
    .array(z.string().min(1))
    .min(1)
    .describe("Repo-relative paths to stage (git add). Use '.' to stage all."),
}

async function execGitStage(args) {
  try {
    await assertRepo(args.cwd)
    await runGit(["add", "--", ...args.paths], args.cwd)
    const { stdout } = await runGit(["status", "--porcelain"], args.cwd)
    return toolText({ staged: args.paths, status: stdout || "(clean)" })
  } catch (err) {
    return toolError(err, "git_stage")
  }
}

export const gitStageTool = tool(
  "git_stage",
  "Stage files for commit (git add). WRITE: mutates the index; requires user approval.",
  gitStageShape,
  execGitStage
)

// ---- git_commit (WRITE) ---------------------------------------------------

const gitCommitShape = {
  cwd: z.string().min(1).describe("Absolute path inside the git repo."),
  message: z.string().min(1).describe("Commit message."),
  signoff: z.boolean().default(false).describe("Append a Signed-off-by trailer."),
}

async function execGitCommit(args) {
  try {
    await assertRepo(args.cwd)
    const argv = ["commit", "-m", args.message]
    if (args.signoff) argv.push("--signoff")
    await runGit(argv, args.cwd)
    const { stdout: hash } = await runGit(["rev-parse", "HEAD"], args.cwd)
    return toolText({ committed: true, hash: hash.trim() })
  } catch (err) {
    return toolError(err, "git_commit")
  }
}

export const gitCommitTool = tool(
  "git_commit",
  "Create a commit from the staged changes (git commit). WRITE: requires user approval.",
  gitCommitShape,
  execGitCommit
)

// ---- Exports --------------------------------------------------------------

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
