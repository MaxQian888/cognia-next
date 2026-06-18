// Process lifecycle WRITE tools: start_process / terminate_process.
//
// Approval gates live with the parent (canUseTool), not here. Spawned PIDs are
// recorded in the shared `trackedPids` registry so terminate_process can refuse
// to kill processes the agent didn't start (unless allowUntracked=true).

import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"

import { toolError, toolText } from "../safety.mjs"
import { execFileAsync } from "../shared/exec.mjs"
import { isProgramAllowed, trackedPids, MAX_OUTPUT_BYTES } from "./inventory.mjs"

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

async function execStartProcess(args) {
  try {
    if (!isProgramAllowed(args.program)) {
      return toolError(`program not on allowlist: ${args.program}`)
    }
    if (args.detached) {
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
    const { stdout, stderr } = await execFileAsync(args.program, args.args, {
      cwd: args.cwd,
      timeout: args.timeoutSecs * 1000,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
    })
    return toolText({
      program: args.program,
      stdout: String(stdout),
      stderr: String(stderr),
      exitCode: 0,
    })
  } catch (err) {
    return toolError(err, "start_process")
  }
}

export const startProcessTool = tool(
  "start_process",
  "Start a process. Program must be on the allowlist. HIGH-RISK — requires user approval.",
  startProcessShape,
  execStartProcess
)

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

async function execTerminateProcess(args) {
  try {
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

export const terminateProcessTool = tool(
  "terminate_process",
  "Terminate a process by PID. HIGH-RISK — requires user approval. Refuses untracked PIDs unless allowUntracked=true.",
  terminateProcessShape,
  execTerminateProcess
)

export { execStartProcess, execTerminateProcess }
