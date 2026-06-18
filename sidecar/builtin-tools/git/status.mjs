// git_status — working-tree status in porcelain v2 (read-only).

import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"

import { toolError, toolText } from "../safety.mjs"
import { runGit, assertRepo } from "./run.mjs"

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

export { execGitStatus }
