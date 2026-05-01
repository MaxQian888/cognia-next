// shell_execute_advanced — guarded shell command execution.
//
// Differs from the SDK's built-in `Bash`:
//   - allowlist + blocklist + dangerous-pattern guard
//   - explicit cwd validation (must exist as a directory)
//   - hard caps: 64 KB output, 5-minute timeout (clamped from caller input)
//   - ALWAYS requires user approval (per category settings)
//
// Use when you want a shell with stricter rails than the SDK Bash, e.g.,
// for users who set `disallowedTools: ["Bash"]` on a character but still
// want certain shell-y operations available behind explicit approval.

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import fs from "node:fs"
import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"

import { toolError, toolText, validateShellCommand } from "./safety.mjs"

const execFileAsync = promisify(execFile)

// Mirror src-tauri/src/shell.rs:17-19 caps so the two paths feel consistent.
const MAX_OUTPUT_BYTES = 64 * 1024
const DEFAULT_TIMEOUT_MS = 30 * 1000
const MAX_TIMEOUT_MS = 5 * 60 * 1000

const shellExecuteAdvancedShape = {
  command: z
    .string()
    .min(1)
    .describe("Program name (e.g. 'git', 'npm', 'python'). Must be on the allowlist."),
  args: z
    .array(z.string())
    .default([])
    .describe("Argv list. No shell interpolation; passed straight to execFile."),
  cwd: z.string().min(1).describe("Working directory. Must exist."),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(MAX_TIMEOUT_MS)
    .default(DEFAULT_TIMEOUT_MS)
    .describe("Hard timeout in ms. Clamped to 5 minutes."),
}

async function execShellExecuteAdvanced(args) {
  try {
    const validation = validateShellCommand(args.command, args.args)
    if (!validation.safe) return toolError(validation.reason, "shell_execute_advanced")

    let cwdStat
    try {
      cwdStat = await fs.promises.stat(args.cwd)
    } catch {
      return toolError(`cwd does not exist: ${args.cwd}`, "shell_execute_advanced")
    }
    if (!cwdStat.isDirectory()) {
      return toolError(`cwd is not a directory: ${args.cwd}`, "shell_execute_advanced")
    }

    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1000, args.timeoutMs))
    const start = Date.now()
    let stdout = ""
    let stderr = ""
    let exitCode = 0
    let timedOut = false
    let error
    try {
      const result = await execFileAsync(args.command, args.args, {
        cwd: args.cwd,
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
      })
      stdout = String(result.stdout)
      stderr = String(result.stderr)
    } catch (err) {
      // execFile rejects with stdout/stderr/code attached on non-zero exit.
      stdout = String(err?.stdout ?? "")
      stderr = String(err?.stderr ?? "")
      exitCode = typeof err?.code === "number" ? err.code : 1
      timedOut = err?.signal === "SIGTERM" || err?.killed === true
      error = err?.message ?? null
    }

    const stdoutTruncated = stdout.length >= MAX_OUTPUT_BYTES
    const stderrTruncated = stderr.length >= MAX_OUTPUT_BYTES
    if (stdoutTruncated) stdout = stdout.slice(0, MAX_OUTPUT_BYTES) + "\n... (truncated)"
    if (stderrTruncated) stderr = stderr.slice(0, MAX_OUTPUT_BYTES) + "\n... (truncated)"

    return toolText({
      command: args.command,
      args: args.args,
      cwd: args.cwd,
      stdout,
      stderr,
      exitCode,
      timedOut,
      stdoutTruncated,
      stderrTruncated,
      durationMs: Date.now() - start,
      error,
    })
  } catch (err) {
    return toolError(err, "shell_execute_advanced")
  }
}

export const shellExecuteAdvancedTool = tool(
  "shell_execute_advanced",
  "Run a single program with argv (no shell interpolation), gated by allowlist + blocklist. HIGH-RISK — always requires user approval.",
  shellExecuteAdvancedShape,
  execShellExecuteAdvanced
)

export const shellAdvancedTools = [shellExecuteAdvancedTool]

export const __testExports = {
  execShellExecuteAdvanced,
  MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
}
