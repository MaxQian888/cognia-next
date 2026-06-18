// Process-manager status + allowlist checks (read-only).

import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"

import { toolError, toolText } from "../safety.mjs"
import { listAllProcesses, formatProcess, isProgramAllowed, trackedPids } from "./inventory.mjs"

// ---- check_program_allowed -----------------------------------------------

const checkProgramAllowedShape = {
  program: z.string().min(1).describe("Program name (path basename)."),
}

async function execCheckProgramAllowed(args) {
  return toolText({
    program: args.program,
    allowed: isProgramAllowed(args.program),
  })
}

export const checkProgramAllowedTool = tool(
  "check_program_allowed",
  "Check whether a program is on the allowlist for start_process.",
  checkProgramAllowedShape,
  execCheckProgramAllowed
)

// ---- get_process_manager_status ------------------------------------------

const getProcessManagerStatusShape = {}

async function execGetProcessManagerStatus() {
  return toolText({
    enabled: true,
    trackedCount: trackedPids.size,
    trackedPids: [...trackedPids],
    platform: process.platform,
  })
}

export const getProcessManagerStatusTool = tool(
  "get_process_manager_status",
  "Report sidecar process-manager status: tracked PIDs and platform.",
  getProcessManagerStatusShape,
  execGetProcessManagerStatus
)

// ---- get_tracked_processes -----------------------------------------------

const getTrackedProcessesShape = {
  includeDetails: z.boolean().default(true).describe("Include process details for tracked PIDs."),
}

async function execGetTrackedProcesses(args) {
  if (trackedPids.size === 0 || !args.includeDetails) {
    return toolText({ trackedCount: trackedPids.size, trackedPids: [...trackedPids] })
  }
  try {
    const all = await listAllProcesses()
    const matched = all.filter((p) => trackedPids.has(p.pid)).map(formatProcess)
    return toolText({
      trackedCount: trackedPids.size,
      trackedPids: [...trackedPids],
      processes: matched,
    })
  } catch (err) {
    return toolError(err, "get_tracked_processes")
  }
}

export const getTrackedProcessesTool = tool(
  "get_tracked_processes",
  "List PIDs the agent has started this session, optionally with live details.",
  getTrackedProcessesShape,
  execGetTrackedProcesses
)

export { execCheckProgramAllowed, execGetProcessManagerStatus, execGetTrackedProcesses }
