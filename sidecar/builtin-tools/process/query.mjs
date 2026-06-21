// Read-only process queries: list / get / search / top_memory.

import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"

import { toolError, toolText } from "../safety.mjs"
import { getProcessSnapshot, formatProcess, compareBy } from "./inventory.mjs"

// ---- list_processes -------------------------------------------------------

const listProcessesShape = {
  name: z.string().optional().describe("Filter by name substring (case-insensitive)."),
  limit: z.number().int().min(1).max(2000).default(100).describe("Cap on rows returned."),
  sortBy: z.enum(["pid", "name", "cpu", "memory"]).default("memory").describe("Sort key."),
  sortDesc: z.boolean().default(true).describe("Sort descending."),
}

async function execListProcesses(args) {
  try {
    const all = await getProcessSnapshot()
    const needle = args.name?.toLowerCase()
    const filtered = needle ? all.filter((p) => p.name.toLowerCase().includes(needle)) : all
    const sorted = filtered.slice().sort((a, b) => compareBy(a, b, args.sortBy, args.sortDesc))
    const sliced = sorted.slice(0, args.limit)
    return toolText({
      total: filtered.length,
      truncated: filtered.length > sliced.length,
      processes: sliced.map(formatProcess),
    })
  } catch (err) {
    return toolError(err, "list_processes")
  }
}

export const listProcessesTool = tool(
  "list_processes",
  "List running processes (read-only). Optional name filter, limit, and sort.",
  listProcessesShape,
  execListProcesses
)

// ---- get_process ----------------------------------------------------------

const getProcessShape = {
  pid: z.number().int().describe("PID of the target process."),
}

async function execGetProcess(args) {
  try {
    const all = await getProcessSnapshot()
    const proc = all.find((p) => p.pid === args.pid)
    if (!proc) return toolError(`no process with pid ${args.pid}`)
    return toolText(formatProcess(proc))
  } catch (err) {
    return toolError(err, "get_process")
  }
}

export const getProcessTool = tool(
  "get_process",
  "Get a single running process by PID (read-only).",
  getProcessShape,
  execGetProcess
)

// ---- search_processes -----------------------------------------------------

const searchProcessesShape = {
  name: z.string().min(1).describe("Process name substring (case-insensitive)."),
  limit: z.number().int().min(1).max(500).default(50).describe("Cap on rows returned."),
}

async function execSearchProcesses(args) {
  try {
    const all = await getProcessSnapshot()
    const needle = args.name.toLowerCase()
    const matches = all.filter((p) => p.name.toLowerCase().includes(needle))
    return toolText({
      query: args.name,
      total: matches.length,
      processes: matches.slice(0, args.limit).map(formatProcess),
    })
  } catch (err) {
    return toolError(err, "search_processes")
  }
}

export const searchProcessesTool = tool(
  "search_processes",
  "Find processes whose name contains the given substring (read-only).",
  searchProcessesShape,
  execSearchProcesses
)

// ---- top_memory_processes -------------------------------------------------

const topMemoryProcessesShape = {
  limit: z.number().int().min(1).max(100).default(10).describe("How many top processes to return."),
}

async function execTopMemoryProcesses(args) {
  try {
    const all = await getProcessSnapshot()
    const sorted = all
      .slice()
      .sort((a, b) => (b.memoryBytes ?? 0) - (a.memoryBytes ?? 0))
      .slice(0, args.limit)
    return toolText({ processes: sorted.map(formatProcess) })
  } catch (err) {
    return toolError(err, "top_memory_processes")
  }
}

export const topMemoryProcessesTool = tool(
  "top_memory_processes",
  "Top N processes ranked by resident memory.",
  topMemoryProcessesShape,
  execTopMemoryProcesses
)

export { execListProcesses, execGetProcess, execSearchProcesses, execTopMemoryProcesses }
