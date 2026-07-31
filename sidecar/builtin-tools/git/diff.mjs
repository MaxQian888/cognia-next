// git_diff — working-tree or staged diff (read-only).

import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"

import { toolError, toolText } from "../safety.mjs"
import { runGit, assertRepo, trimTail } from "./run.mjs"

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
    const guidance = truncated
      ? "\n(diff truncated — narrow it with the `pathspec` argument or a smaller `context`.)"
      : ""
    return toolText(`${text}${guidance}`)
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

export { execGitDiff }
