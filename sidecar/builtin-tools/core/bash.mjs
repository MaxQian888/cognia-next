// Core `bash` tool — free-form shell execution for the ai-sdk path.
//
// Deliberately DIFFERENT from `shell_execute_advanced` (allowlist-gated,
// single-program): this tool accepts an arbitrary shell command line, and the
// safety story is the permission round-trip (requiresApproval: true → the
// user approves each call unless a ruleset rule allows it), the restricted-
// mode denylist, and the doom-loop guard. The DANGEROUS_PATTERNS scan from
// safety.mjs still hard-rejects obvious destructive chaining as
// defence-in-depth.

import os from "node:os"
import { spawn } from "node:child_process"
import { createWriteStream } from "node:fs"
import fsp from "node:fs/promises"
import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"

import { toolError, toolText, DANGEROUS_PATTERNS } from "../safety.mjs"
import { tailTruncate } from "../shared/truncate.mjs"
import { pickStreamDecoder } from "../shared/console-decode.mjs"
import { activeShellDescriptor, bashToolDescription } from "../shared/shell-detect.mjs"
import { resolveToolPath } from "./read.mjs"

// Re-exported for back-compat: the canonical implementation now lives in
// shared/truncate.mjs (shared with future tail-keeping tools). bash.test.mjs
// imports it from here.
export { tailTruncate }

export const DEFAULT_TIMEOUT_MS = 120_000
export const MAX_TIMEOUT_MS = 600_000
export const MAX_OUTPUT_CHARS = 30_000
/** Chars of the head kept for the truncated preview (rest comes from the tail). */
export const PREVIEW_HEAD_CHARS = 12_000

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

/**
 * Resolve the platform shell + argv + scrubbed env for a command line (shared
 * sync/bg). The shell is the host's preferred interactive shell — PowerShell on
 * Windows when present, else cmd.exe, else `/bin/sh` — resolved once and cached
 * in shell-detect. `env` drops PowerShell injection vectors (PSModulePath, …) for
 * PowerShell shells and is the live `process.env` otherwise.
 */
export function resolveShellInvocation(command, descriptor = activeShellDescriptor()) {
  return {
    isWin: descriptor.isWin,
    shell: descriptor.bin,
    shellArgs: descriptor.buildArgs(command),
    env: descriptor.sanitizeEnv(process.env),
  }
}

/**
 * Build the tool body from a captured run. When the full output was spilled to
 * a file and exceeds the inline budget, return a head + tail preview pointing at
 * the file (Claude Code parity — the model can `read` the file for the rest);
 * otherwise return the (possibly tail-truncated) output inline.
 *
 * @param {{ head: string, tail: string, total: number, fullPath: string|null }} args
 * @returns {{ body: string, truncated: boolean }}
 */
export function composeBashBody({ head, tail, total, fullPath }) {
  if (!fullPath || total <= MAX_OUTPUT_CHARS) {
    // `tail` carries the full output when it fits the in-memory window.
    const t = tailTruncate(tail)
    return { body: t.text, truncated: t.truncated }
  }
  const omitted = Math.max(0, total - head.length - tail.length)
  const body =
    `${head}\n… (${omitted} characters omitted — full output saved to ${fullPath}; ` +
    `read it with the read tool for the complete log) …\n${tail}`
  return { body, truncated: true }
}

/** Temp path for spilling a single bash run's full output. */
function bashSpillPath() {
  const rand = Math.floor(Math.random() * 1e9)
  return `${os.tmpdir()}/cognia-bash-${process.pid}-${Date.now()}-${rand}.log`
}

export function createBashTool({ cwd, bgShells, shell }) {
  // The shell descriptor the tool drives. Defaults to the host's preferred shell
  // (PowerShell on Windows when present); injectable so tests pin a deterministic
  // shell regardless of what the runner machine happens to have on PATH.
  const descriptor = shell ?? activeShellDescriptor()
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
      const { isWin, shell, shellArgs, env } = resolveShellInvocation(args.command, descriptor)

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
          env,
        })
        return toolText(
          `background shell started: ${entry.id} (status: running). Poll output with bash_output({ shellId: "${entry.id}" }) and stop it with kill_shell.`
        )
      }

      const timeoutMs = Math.min(args.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
      const tmpPath = bashSpillPath()

      const result = await new Promise((resolve) => {
        const child = spawn(shell, shellArgs, {
          cwd: workdir,
          env,
          windowsHide: true,
          windowsVerbatimArguments: isWin,
          stdio: ["ignore", "pipe", "pipe"],
        })
        // Keep a bounded head (frozen) + a rolling tail in memory for the
        // preview, and stream the full combined output to a temp file so large
        // logs aren't lost to truncation.
        let head = ""
        let mem = ""
        let total = 0
        let timedOut = false
        let fileOk = true
        let stream = null
        try {
          stream = createWriteStream(tmpPath)
          stream.on("error", () => {
            fileOk = false
          })
        } catch {
          fileOk = false
        }
        // Decode bytes auto-detecting the console encoding (UTF-8, or the OEM
        // code page on Windows — cmd built-ins print GBK/Shift-JIS/… to a pipe).
        // One streaming decoder per run, picked from the first chunk and flushed
        // at the end, so multibyte chars split across chunks decode intact.
        let decoder = null
        const append = (s) => {
          if (!s) return
          total += s.length
          if (head.length < PREVIEW_HEAD_CHARS) head += s.slice(0, PREVIEW_HEAD_CHARS - head.length)
          mem += s
          if (mem.length > MAX_OUTPUT_CHARS * 2) mem = mem.slice(-MAX_OUTPUT_CHARS * 2)
          if (fileOk && stream) {
            try {
              stream.write(s)
            } catch {
              fileOk = false
            }
          }
        }
        const cap = (chunk) => {
          if (!decoder) decoder = pickStreamDecoder(chunk)
          append(decoder.decode(chunk, { stream: true }))
        }
        child.stdout.on("data", cap)
        child.stderr.on("data", cap)
        const timer = setTimeout(() => {
          timedOut = true
          child.kill()
        }, timeoutMs)
        const finish = (extra) => {
          clearTimeout(timer)
          // Flush any bytes the streaming decoder is holding for a partial char.
          if (decoder) append(decoder.decode())
          const done = () => resolve({ head, mem, total, fileOk, tmpPath, timedOut, ...extra })
          if (stream) stream.end(done)
          else done()
        }
        child.on("error", (err) => {
          fileOk = false
          append(String(err.message ?? err))
          finish({ code: null })
        })
        child.on("close", (code) => finish({ code }))
      })

      const tailPreview = result.mem.slice(-(MAX_OUTPUT_CHARS - PREVIEW_HEAD_CHARS))
      let fullPath = null
      if (result.fileOk && result.total > MAX_OUTPUT_CHARS) {
        fullPath = result.tmpPath
      } else if (result.fileOk) {
        // Small enough to inline — drop the spill file.
        fsp.unlink(result.tmpPath).catch(() => {})
      }
      const { body: outBody, truncated } = composeBashBody({
        head: result.head,
        tail: tailPreview,
        total: result.total,
        fullPath,
      })

      const lines = [outBody.trimEnd()]
      if (truncated && !fullPath) lines.push("(output truncated — only the tail is shown)")
      if (result.timedOut) lines.push(`(command timed out after ${timeoutMs} ms and was killed)`)
      if (result.code !== 0 && result.code !== null) lines.push(`(exit code ${result.code})`)
      const body = lines.filter((l) => l.length > 0).join("\n")
      const failed = result.timedOut || (result.code !== 0 && result.code !== null)
      return failed ? toolText(body, { isError: true }) : toolText(body || "(no output)")
    } catch (err) {
      return toolError(err, "bash")
    }
  }

  return tool("bash", bashToolDescription(descriptor), bashShape, execBash)
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
