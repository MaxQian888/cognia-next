// git_repo_inspect + git_changes — repo snapshot (read-only).

import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"

import { toolError, toolText } from "../safety.mjs"
import { runGit, assertRepo } from "./run.mjs"

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

export { execGitRepoInspect, execGitChanges }
