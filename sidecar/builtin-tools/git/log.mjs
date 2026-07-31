// git_log + git_history — commit history (read-only).

import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"

import { toolError, toolText } from "../safety.mjs"
import { runGit, assertRepo } from "./run.mjs"

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

export { execGitLog, execGitHistory }
