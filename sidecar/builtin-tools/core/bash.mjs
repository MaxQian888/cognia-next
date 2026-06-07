// Core `bash` tool — free-form shell execution for the ai-sdk path.
//
// Deliberately DIFFERENT from `shell_execute_advanced` (allowlist-gated,
// single-program): this tool accepts an arbitrary shell command line, and the
// safety story is the permission round-trip (requiresApproval: true → the
// user approves each call unless a ruleset rule allows it), the restricted-
// mode denylist, and the doom-loop guard. The DANGEROUS_PATTERNS scan from
// safety.mjs still hard-rejects obvious destructive chaining as
// defence-in-depth.

import { spawn } from "node:child_process"
import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"

import { toolError, toolText, DANGEROUS_PATTERNS } from "../safety.mjs"
import { resolveToolPath } from "./read.mjs"

export const DEFAULT_TIMEOUT_MS = 120_000
export const MAX_TIMEOUT_MS = 600_000
export const MAX_OUTPUT_CHARS = 30_000

export const bashShape = {
  command: z.string().min(1).describe("The shell command line to execute."),
  description: z
    .string()
    .optional()
    .describe(
      "One-line description of what the command does (shown to the user in the approval prompt)."
    ),
  timeout: z
    .number()
    .int()
    .min(1)
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(`Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`),
  workdir: z
    .string()
    .optional()
    .describe("Working directory for the command. Defaults to the session working directory."),
}

/** Keep the TAIL of combined output — the end carries the verdict. */
export function tailTruncate(text, max = MAX_OUTPUT_CHARS) {
  if (text.length <= max) return { text, truncated: false }
  return {
    text: `… (${text.length - max} earlier characters dropped)\n${text.slice(-max)}`,
    truncated: true,
  }
}

export function createBashTool({ cwd }) {
  async function execBash(args) {
    try {
      for (const pattern of DANGEROUS_PATTERNS) {
        if (pattern.test(args.command)) {
          return toolError(
            "command rejected: it chains into a destructive operation (rm/format/shutdown/...). Run the destructive step through the dedicated file/process tools so it gets its own approval."
          )
        }
      }
      const workdir = resolveToolPath(cwd, args.workdir ?? ".")
      const timeoutMs = Math.min(args.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
      const isWin = process.platform === "win32"
      const shell = isWin ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh"
      const shellArgs = isWin ? ["/d", "/s", "/c", args.command] : ["-c", args.command]

      const result = await new Promise((resolve) => {
        const child = spawn(shell, shellArgs, {
          cwd: workdir,
          windowsHide: true,
          windowsVerbatimArguments: isWin,
          stdio: ["ignore", "pipe", "pipe"],
        })
        let out = ""
        let timedOut = false
        const cap = (chunk) => {
          out += chunk
          // Keep a rolling window of 2× the final budget to bound memory.
          if (out.length > MAX_OUTPUT_CHARS * 2) out = out.slice(-MAX_OUTPUT_CHARS * 2)
        }
        child.stdout.on("data", cap)
        child.stderr.on("data", cap)
        const timer = setTimeout(() => {
          timedOut = true
          child.kill()
        }, timeoutMs)
        child.on("error", (err) => {
          clearTimeout(timer)
          resolve({ out: String(err.message ?? err), code: null, timedOut })
        })
        child.on("close", (code) => {
          clearTimeout(timer)
          resolve({ out, code, timedOut })
        })
      })

      const { text, truncated } = tailTruncate(result.out)
      const lines = [text.trimEnd()]
      if (truncated) lines.push("(output truncated — only the tail is shown)")
      if (result.timedOut) lines.push(`(command timed out after ${timeoutMs} ms and was killed)`)
      if (result.code !== 0 && result.code !== null) lines.push(`(exit code ${result.code})`)
      const body = lines.filter((l) => l.length > 0).join("\n")
      const failed = result.timedOut || (result.code !== 0 && result.code !== null)
      return failed ? toolText(body, { isError: true }) : toolText(body || "(no output)")
    } catch (err) {
      return toolError(err, "bash")
    }
  }

  return tool(
    "bash",
    "Execute a shell command (cmd on Windows, sh elsewhere) in the session working directory and return its combined output. Long output keeps the tail. Each call is approval-gated unless a permission rule allows it.",
    bashShape,
    execBash
  )
}
