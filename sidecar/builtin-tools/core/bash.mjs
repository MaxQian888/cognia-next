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

import { toolError, toolText, DANGEROUS_PATTERNS, findDangerousShellFragment } from "../safety.mjs"
import { tailTruncate } from "../shared/truncate.mjs"
import { pickStreamDecoder } from "../shared/console-decode.mjs"
import {
  activeShellDescriptor,
  applyNonInteractiveEnv,
  bashToolDescription,
} from "../shared/shell-detect.mjs"
import { detectInteractiveCommand } from "../shared/interactive-detect.mjs"
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
  detach: z
    .boolean()
    .optional()
    .describe(
      "Keep the background command running after this chat session ends (it still stops when the app exits). Requires run_in_background. Use only when the work genuinely must outlive the conversation, such as a long build you will check back on later."
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
    .describe(
      "Optional regular expression; only output lines matching it are returned. Combined with wait_ms this waits UNTIL a line matches (or the shell exits), which is the way to block on a readiness line such as 'server listening'."
    ),
  from_offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Absolute byte offset to read from, for looking back at earlier output. Omit to continue from where the last read left off. Reads never consume, so an earlier range can always be re-read."
    ),
  wait_ms: z
    .number()
    .int()
    .min(0)
    .max(30_000)
    .optional()
    .describe(
      "Long-poll for new output or process exit for up to this many milliseconds (max 30000). Defaults to 0 (return immediately)."
    ),
  max_chars: z
    .number()
    .int()
    .min(1)
    .max(30_000)
    .optional()
    .describe(
      "Maximum new characters to return in this call. Remaining output stays unread for the next call."
    ),
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
    // Drop shell-specific injection vectors, then pin the non-interactive vars
    // (pager/editor/credential prompts) so a git/pager command can't hang the turn.
    env: applyNonInteractiveEnv(descriptor.sanitizeEnv(process.env), descriptor),
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
      // A one-shot capture shell has no TTY: an interactive program (REPL,
      // editor, ssh, login flow, `git rebase -i`, `psql`, `top`, …) would hang
      // or read EOF here. Reject it early — before any spawn — and point at the
      // PTY escape hatch. Background mode is exempt (a user may intentionally
      // detach a long-running process).
      if (!args.run_in_background) {
        const interactive = detectInteractiveCommand(args.command)
        if (interactive.interactive) {
          const head = interactive.head ?? "command"
          return toolError(
            `command "${head}" is interactive and needs a TTY; the bash tool runs without one, so it would hang or read EOF. Run it through terminal_repl_spawn (a PTY): terminal_repl_spawn({ shell: "${head}", ... }) → terminal_repl_write (append "\\n" to submit) → terminal_repl_read. For git/*-i style, pass a non-interactive flag instead (e.g. git rebase without -i, git commit -m "...").`
          )
        }
      }
      // Parse Bash structurally so quoted examples and safe sinks such as
      // >/dev/null are not confused with executable destructive fragments.
      // PowerShell/cmd use their own grammar, so retain the legacy fail-closed
      // scan on Windows rather than pretending a Bash AST represents them.
      let dangerous = null
      if (descriptor.isWin) {
        for (const pattern of DANGEROUS_PATTERNS) {
          const match = args.command.match(pattern)
          if (match) {
            dangerous = { fragment: match[0], kind: "command" }
            break
          }
        }
      } else {
        dangerous = findDangerousShellFragment(args.command)
      }
      if (dangerous) {
        const category =
          dangerous.kind === "deviceRedirect" ? "unsafe device redirect" : "destructive command"
        return toolError(
          `command rejected: matched ${category} ${JSON.stringify(dangerous.fragment)}. ` +
            "Run the destructive step through the dedicated file/process tools so it gets its own approval."
        )
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
        // Host-backed registries answer over `host_rpc`, so this is async; the
        // in-process fallback returns synchronously and awaits harmlessly.
        const entry = await bgShells.spawnBackground({
          command: args.command,
          shell,
          shellArgs,
          cwd: workdir,
          isWin,
          env,
          detach: args.detach === true,
          label: args.description,
        })
        const scope = args.detach
          ? " It will keep running after this session ends, until the app exits."
          : ""
        return toolText(
          `background shell started: ${entry.id} (status: running).${scope} Poll output with bash_output({ shellId: "${entry.id}" }) and stop it with kill_shell.`
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
          stdio: ["pipe", "pipe", "pipe"],
        })
        // Keep fd 0 connected without relying on /dev/null, which may be
        // unavailable inside the macOS sandbox. End it immediately so
        // non-interactive commands that probe stdin observe EOF instead of
        // waiting for input.
        child.stdin.end()
        // Keep a bounded head (frozen) + a rolling tail in memory for the
        // preview. The full combined output is spilled to a temp file ONLY when
        // it grows past the inline budget — most commands print far less, so we
        // avoid creating/writing/deleting a temp file per run. `pending` buffers
        // the complete output until the spill file opens, then is discarded; it
        // is bounded by MAX_OUTPUT_CHARS + one chunk, so memory stays capped.
        let head = ""
        let mem = ""
        let pending = ""
        let total = 0
        let timedOut = false
        let fileOk = true
        let stream = null
        let spilling = false
        let fileCreated = false
        const openSpill = () => {
          spilling = true // never attempt to open twice, even on failure
          try {
            stream = createWriteStream(tmpPath)
            stream.on("error", () => {
              fileOk = false
            })
            fileCreated = true
            stream.write(pending)
          } catch {
            fileOk = false
            stream = null
          }
          pending = "" // freed whether the open succeeded or not
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
          if (!spilling) {
            pending += s
            if (total > MAX_OUTPUT_CHARS) openSpill()
          } else if (fileOk && stream) {
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
          const done = () =>
            resolve({ head, mem, total, fileOk, fileCreated, tmpPath, timedOut, ...extra })
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
      if (result.fileCreated && result.fileOk && result.total > MAX_OUTPUT_CHARS) {
        fullPath = result.tmpPath
      } else if (result.fileCreated) {
        // A spill file was opened but the output ended up inline (or the stream
        // errored) — drop it. Small runs never create a file, so this is rare.
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
    const readOptions = {
      filter: args.filter,
      maxChars: args.max_chars,
      waitMs: args.wait_ms,
      fromOffset: args.from_offset,
    }
    // A long-poll only makes sense from the live cursor; an explicit look-back
    // offset is a history read and returns immediately.
    const r =
      args.wait_ms && args.from_offset === undefined && typeof bgShells.waitForOutput === "function"
        ? await bgShells.waitForOutput(args.shellId, readOptions)
        : await bgShells.read(args.shellId, readOptions)
    if (!r.ok) return toolError(r.reason ?? `no background shell with id ${args.shellId}`)
    const status =
      r.status === "exited" || (r.status && r.status !== "running")
        ? `(status: ${r.status}${r.exitCode != null ? `, exit code ${r.exitCode}` : ""})`
        : "(status: running)"
    const body = r.data && r.data.length > 0 ? r.data.trimEnd() : "(no new output)"
    // Surfacing the offset lets the model page back deliberately instead of
    // guessing, now that reads are non-destructive.
    const cursor =
      r.nextOffset != null
        ? `\n(next offset: ${r.nextOffset}${r.hasMore ? ", more available" : ""})`
        : ""
    return toolText(`${body}\n${status}${cursor}`)
  }

  return tool(
    "bash_output",
    "Read new output from a background shell started with bash(run_in_background). Returns only the unread delta plus status. Use wait_ms to long-poll efficiently instead of repeatedly polling, and max_chars to page large output without losing the remainder.",
    bashOutputShape,
    execBashOutput
  )
}

/** List every background shell owned by this Agent session. */
export function createListShellsTool({ bgShells }) {
  async function execListShells() {
    if (!bgShells) {
      return toolError("background shells are not available in this session")
    }
    return toolText(JSON.stringify({ shells: await bgShells.list() }, null, 2))
  }

  return tool(
    "list_shells",
    "List background shells started by bash(run_in_background), including command, status, exit code, working directory, start/end times, and duration. Use it to recover shell ids before bash_output or kill_shell.",
    {},
    execListShells,
    { alwaysLoad: true }
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
    const r = await bgShells.kill(args.shellId)
    if (!r.ok) return toolError(r.reason ?? `no background shell with id ${args.shellId}`)
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
