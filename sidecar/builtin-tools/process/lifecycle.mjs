// Process lifecycle WRITE tools: start_process / terminate_process.
//
// Approval gates live with the parent (canUseTool), not here. Spawned PIDs are
// recorded in the shared `trackedPids` registry so terminate_process can refuse
// to kill processes the agent didn't start (unless allowUntracked=true).
//
// When a background-job supervisor is available (`ctx.bgShells`), `detached`
// starts route through it instead of `spawn({detached:true, stdio:"ignore"})`
// + `unref()`. That old shape produced a genuine orphan daemon: no output was
// captured, nothing tracked it across a sidecar restart, and it outlived the
// app itself. Routing through the supervisor keeps the documented contract
// ("return immediately") while making the child reapable, observable, and
// bounded by the app's lifetime.

import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"

import { toolError, toolText } from "../safety.mjs"
import { execFileAsync } from "../shared/exec.mjs"
import { headTruncate } from "../shared/truncate.mjs"
import { isProgramAllowed, trackedPids, MAX_OUTPUT_BYTES } from "./inventory.mjs"

// Per-stream display cap for captured output. The 1 MB `maxBuffer` bounds what
// we read from the child; this bounds what we hand the model so a chatty
// command can't flood the context. Mirrors the head-truncate contract the git
// and shell-advanced tools use.
export const OUTPUT_DISPLAY_CHARS = 16_000

/** Head-truncate a captured stream for display. */
function clipStream(text) {
  return headTruncate(String(text), OUTPUT_DISPLAY_CHARS).text
}

// ---- start_process --------------------------------------------------------

const startProcessShape = {
  program: z.string().min(1).describe("Program name (must be on the allowlist)."),
  args: z.array(z.string()).default([]).describe("Argv list (no shell expansion)."),
  cwd: z.string().optional().describe("Working directory."),
  detached: z.boolean().default(true).describe("Run detached (return immediately)."),
  timeoutSecs: z
    .number()
    .int()
    .min(1)
    .max(300)
    .default(30)
    .describe("Timeout in seconds (only relevant when detached=false)."),
}

async function execStartProcess(args, ctx = {}) {
  const { bgShells } = ctx
  try {
    if (!isProgramAllowed(args.program)) {
      return toolError(`program not on allowlist: ${args.program}`)
    }
    if (args.detached) {
      // Preferred path: a supervised background job. `detached` here means
      // "return immediately" (the tool's documented contract), NOT "outlive
      // the session" — so the job stays session-owned.
      if (bgShells) {
        const entry = await bgShells.spawnBackground({
          command: [args.program, ...args.args].join(" "),
          shell: args.program,
          shellArgs: args.args,
          cwd: args.cwd,
          label: args.program,
        })
        // Record the pid here too. This is the path that actually runs in every
        // production wiring (`collectCogniaToolDefs` always supplies bgShells),
        // and it used to return without touching `trackedPids` — so
        // `get_tracked_processes` was permanently empty,
        // `get_process_manager_status` reported `enabled: true` for a registry
        // that could never be non-empty, and `terminate_process` refused pids
        // this very call had just spawned.
        if (entry.pid) trackedPids.add(entry.pid)
        return toolText({
          pid: entry.pid ?? null,
          jobId: entry.id,
          detached: true,
          program: args.program,
          note: `Output is captured — read it with bash_output({ shellId: "${entry.id}" }) and stop it with kill_shell or terminate_process.`,
        })
      }
      // Fallback (no supervisor, e.g. the standalone tool bridge): the legacy
      // fire-and-forget spawn. Output is lost and the child is unsupervised.
      const { spawn } = await import("node:child_process")
      const child = spawn(args.program, args.args, {
        cwd: args.cwd,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      })
      child.unref()
      if (child.pid) trackedPids.add(child.pid)
      return toolText({ pid: child.pid ?? null, detached: true, program: args.program })
    }
    // Synchronous-ish: capture output up to timeout.
    try {
      const { stdout, stderr } = await execFileAsync(args.program, args.args, {
        cwd: args.cwd,
        timeout: args.timeoutSecs * 1000,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
      })
      return toolText({
        program: args.program,
        stdout: clipStream(stdout),
        stderr: clipStream(stderr),
        exitCode: 0,
      })
    } catch (err) {
      // A non-zero exit is a normal program outcome, not a tool failure: the
      // rejection still carries the captured output and the real exit code.
      // Surfacing them (instead of a bare error) lets the model see WHY the
      // command failed — same philosophy as the bash tool. Only a genuine
      // spawn failure (ENOENT, EACCES — no numeric `code`) is a tool error.
      if (err && typeof err.code === "number") {
        return toolText({
          program: args.program,
          stdout: clipStream(err.stdout ?? ""),
          stderr: clipStream(err.stderr ?? ""),
          exitCode: err.code,
          ...(err.killed ? { killed: true, timedOut: true } : {}),
        })
      }
      throw err
    }
  } catch (err) {
    return toolError(err, "start_process")
  }
}

/** Supervisor-less defaults, kept so the static category and tests still work. */
export const startProcessTool = createStartProcessTool()
export function createStartProcessTool(ctx = {}) {
  return tool(
    "start_process",
    "Start a process. Program must be on the allowlist. HIGH-RISK — requires user approval.",
    startProcessShape,
    (args) => execStartProcess(args, ctx)
  )
}

// ---- terminate_process ----------------------------------------------------

const terminateProcessShape = {
  pid: z.number().int().describe("PID of the target process."),
  force: z.boolean().default(false).describe("Send SIGKILL/TerminateProcess instead of SIGTERM."),
  allowUntracked: z
    .boolean()
    .default(false)
    .describe(
      "Allow killing processes the agent did NOT start. Default is false to avoid stomping on the user's work."
    ),
}

async function execTerminateProcess(args, ctx = {}) {
  const { bgShells } = ctx
  try {
    // A supervised job is killed through the supervisor so the WHOLE process
    // group goes, not just the pid the model happens to hold. Signalling the
    // pid directly would leave its children alive — the exact defect this
    // subsystem exists to fix.
    if (bgShells?.killByPid) {
      const outcome = await bgShells.killByPid(args.pid)
      if (outcome.matched) {
        return outcome.ok
          ? toolText({
              pid: args.pid,
              jobId: outcome.jobId,
              terminated: true,
              processGroup: true,
            })
          : toolError(outcome.reason ?? `could not terminate job for pid ${args.pid}`)
      }
      // Not a supervised job — fall through to the raw-signal path below.
    }
    if (!trackedPids.has(args.pid) && !args.allowUntracked) {
      return toolError(
        `pid ${args.pid} was not started by this session — pass allowUntracked=true to override`
      )
    }
    const signal = args.force ? "SIGKILL" : "SIGTERM"
    process.kill(args.pid, signal)
    trackedPids.delete(args.pid)
    return toolText({ pid: args.pid, signal, terminated: true })
  } catch (err) {
    return toolError(err, "terminate_process")
  }
}

export const terminateProcessTool = createTerminateProcessTool()
export function createTerminateProcessTool(ctx = {}) {
  return tool(
    "terminate_process",
    "Terminate a process by PID. HIGH-RISK — requires user approval. Refuses untracked PIDs unless allowUntracked=true.",
    terminateProcessShape,
    (args) => execTerminateProcess(args, ctx)
  )
}

export { execStartProcess, execTerminateProcess }
