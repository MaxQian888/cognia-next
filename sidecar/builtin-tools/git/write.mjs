// git_stage + git_commit — WRITE tools (mutate the index/history).
//
// Deliberately NOT `alwaysLoad` and carry no allow-by-default: a call routes
// through the sidecar permission resolver → renderer `permission_request`, so
// the user confirms each stage/commit. Network/destructive ops (push, reset, …)
// are intentionally not exposed here.

import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"

import { toolError, toolText } from "../safety.mjs"
import { runGit, assertRepo } from "./run.mjs"

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
    // `git add` exits 0 having staged nothing when every path matched only
    // ignored or unchanged files. Echoing `args.paths` as `staged` therefore
    // asserted something git never confirmed. Report what the index actually
    // holds; `requested` keeps the model's own input visible for comparison.
    const { stdout: stagedOut } = await runGit(["diff", "--cached", "--name-only"], args.cwd)
    const staged = stagedOut.split(/\r?\n/).filter(Boolean)
    return toolText({
      requested: args.paths,
      staged,
      stagedCount: staged.length,
      ...(staged.length === 0
        ? {
            note: "git add staged nothing — the paths may be ignored, unchanged, or already staged.",
          }
        : {}),
      status: stdout || "(clean)",
    })
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

export { execGitStage, execGitCommit }
