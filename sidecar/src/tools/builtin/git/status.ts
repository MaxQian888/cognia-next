// git_status — working-tree status in porcelain v2 (read-only).

import { z } from "zod"

import { tool, type ToolArgs } from "../../kernel/define.ts"
import { toolError, toolText } from "../../kernel/result.ts"
import { runGit } from "../../../platform/process/git.ts"
import { assertRepo } from "./run.ts"

const gitStatusShape = {
  cwd: z.string().min(1).describe("Absolute path inside the git repo."),
}

async function execGitStatus(args: ToolArgs<typeof gitStatusShape>) {
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
