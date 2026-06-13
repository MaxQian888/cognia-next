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
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      "Run the command in the background and return a shellId immediately instead of waiting. Poll its output with bash_output and stop it with kill_shell. Use for dev servers, watchers, and long builds."
    ),
}

export const bashOutputShape = {
  shellId: z
    .string()
    .min(1)
    .describe("The shellId returned by bash when run_in_background was true."),
  filter: z
    .string()
    .optional()
    .describe("Optional regular expression; only output lines matching it are returned."),
}

export const killShellShape = {
  shellId: z.string().min(1).describe("The shellId of the background shell to terminate."),
}

/** Resolve the platform shell + argv for a command line (shared sync/bg). */
export function resolveShellInvocation(command) {
  const isWin = process.platform === "win32"
  const shell = isWin ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh"
  const shellArgs = isWin ? ["/d", "/s", "/c", command] : ["-c", command]
  return { isWin, shell, shellArgs }
}

/** Keep the TAIL of combined output — the end carries the verdict. */
export function tailTruncate(text, max = MAX_OUTPUT_CHARS) {
  if (text.length <= max) return { text, truncated: false }
  return {
    text: `… (${text.length - max} earlier characters dropped)\n${text.slice(-max)}`,
    truncated: true,
  }
}

export function createBashTool({ cwd, bgShells }) {
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
      const { isWin, shell, shellArgs } = resolveShellInvocation(args.command)

      // Background mode: spawn, register, and return a handle immediately.
      if (args.run_in_background) {
        if (!bgShells) {
          return toolError(
            "background execution is not available in this session (no background-shell registry)"
          )
        }
        const entry = bgShells.spawnBackground({
          command: args.command,
          shell,
          shellArgs,
          cwd: workdir,
          isWin,
        })
        return toolText(
          `background shell started: ${entry.id} (status: running). Poll output with bash_output({ shellId: "${entry.id}" }) and stop it with kill_shell.`
        )
      }

      const timeoutMs = Math.min(args.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)

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
    "Execute a shell command (cmd on Windows, sh elsewhere) in the session working directory and return its combined output. Long output keeps the tail. Set run_in_background to start a long-running command and poll it with bash_output. Each call is approval-gated unless a permission rule allows it.",
    bashShape,
    execBash
  )
}

/**
 * `bash_output` — read new output from a background shell started by
 * `bash({ run_in_background: true })`. Non-destructive incremental read:
 * returns only the output appended since the previous poll plus the shell's
 * current status/exit code. Read-only.
 *
 * @param {{ bgShells?: ReturnType<typeof import("./bash-sessions.mjs").createBgShellRegistry> }} ctx
 */
export function createBashOutputTool({ bgShells }) {
  async function execBashOutput(args) {
    if (!bgShells) {
      return toolError("background shells are not available in this session")
    }
    const r = bgShells.read(args.shellId, { filter: args.filter })
    if (!r.ok) return toolError(`no background shell with id ${args.shellId}`)
    const status =
      r.status === "exited"
        ? `(status: exited${r.exitCode != null ? `, exit code ${r.exitCode}` : ""})`
        : "(status: running)"
    const body = r.data && r.data.length > 0 ? r.data.trimEnd() : "(no new output)"
    return toolText(`${body}\n${status}`)
  }

  return tool(
    "bash_output",
    "Read new output from a background shell started with bash(run_in_background). Returns only the output since the last poll plus the shell's status — call repeatedly to follow a long-running command.",
    bashOutputShape,
    execBashOutput
  )
}

/**
 * `kill_shell` — terminate a background shell started by `bash`. Idempotent;
 * safe to call on an already-exited shell.
 *
 * @param {{ bgShells?: ReturnType<typeof import("./bash-sessions.mjs").createBgShellRegistry> }} ctx
 */
export function createKillShellTool({ bgShells }) {
  async function execKillShell(args) {
    if (!bgShells) {
      return toolError("background shells are not available in this session")
    }
    const r = bgShells.kill(args.shellId)
    if (!r.ok) return toolError(`no background shell with id ${args.shellId}`)
    return toolText(
      `killed background shell ${args.shellId}${r.exitCode != null ? ` (exit code ${r.exitCode})` : ""}`
    )
  }

  return tool(
    "kill_shell",
    "Terminate a background shell started with bash(run_in_background). Idempotent.",
    killShellShape,
    execKillShell
  )
}
