// Assembler for the `process` builtin category — list/query/manage processes.
//
// Tools are emitted in the FIXED order of PROCESS_TOOL_NAMES (prompt-cache
// stability). New tools are APPENDED.

import {
  listProcessesTool,
  getProcessTool,
  searchProcessesTool,
  topMemoryProcessesTool,
  execListProcesses,
  execGetProcess,
  execSearchProcesses,
  execTopMemoryProcesses,
} from "./query.mjs"
import {
  checkProgramAllowedTool,
  getProcessManagerStatusTool,
  getTrackedProcessesTool,
  execCheckProgramAllowed,
  execGetProcessManagerStatus,
  execGetTrackedProcesses,
} from "./manager.mjs"
import {
  startProcessTool,
  terminateProcessTool,
  createStartProcessTool,
  createTerminateProcessTool,
  execStartProcess,
  execTerminateProcess,
} from "./lifecycle.mjs"
import {
  parsePosixPs,
  parseWindowsCsv,
  parseCsvRow,
  isProgramAllowed,
  formatProcess,
  trackedPids,
  pickField,
  compareBy,
} from "./inventory.mjs"

/** Fixed registration order — do not reorder (prompt-cache stability). */
export const PROCESS_TOOL_NAMES = Object.freeze([
  "list_processes",
  "get_process",
  "search_processes",
  "top_memory_processes",
  "check_program_allowed",
  "get_process_manager_status",
  "get_tracked_processes",
  "start_process",
  "terminate_process",
])

export const processTools = [
  listProcessesTool,
  getProcessTool,
  searchProcessesTool,
  topMemoryProcessesTool,
  checkProgramAllowedTool,
  getProcessManagerStatusTool,
  getTrackedProcessesTool,
  startProcessTool,
  terminateProcessTool,
]

/**
 * Build the process category bound to a session's background-job supervisor.
 *
 * Only the two WRITE tools care: `start_process` spawns through the supervisor
 * so a `detached` start is reapable and captured rather than an orphan daemon,
 * and `terminate_process` kills the whole process group of a supervised job.
 * The seven read-only tools are shared verbatim, so a missing supervisor
 * degrades the category rather than removing it.
 *
 * Emission order is identical to `processTools` — see PROCESS_TOOL_NAMES.
 */
export function createProcessTools(ctx = {}) {
  if (!ctx.bgShells) return processTools
  return assertOrder([
    listProcessesTool,
    getProcessTool,
    searchProcessesTool,
    topMemoryProcessesTool,
    checkProgramAllowedTool,
    getProcessManagerStatusTool,
    getTrackedProcessesTool,
    createStartProcessTool(ctx),
    createTerminateProcessTool(ctx),
  ])
}

/** Defensive: the emitted order must match the public constant. */
function assertOrder(tools) {
  for (let i = 0; i < tools.length; i++) {
    if (tools[i].name !== PROCESS_TOOL_NAMES[i]) {
      throw new Error(
        `process tool order drift: expected ${PROCESS_TOOL_NAMES[i]}, got ${tools[i].name}`
      )
    }
  }
  return tools
}

assertOrder(processTools)

export const __testExports = {
  execListProcesses,
  execGetProcess,
  execSearchProcesses,
  execTopMemoryProcesses,
  execCheckProgramAllowed,
  execGetProcessManagerStatus,
  execGetTrackedProcesses,
  execStartProcess,
  execTerminateProcess,
  parsePosixPs,
  parseWindowsCsv,
  parseCsvRow,
  isProgramAllowed,
  formatProcess,
  trackedPids,
  pickField,
  compareBy,
}
