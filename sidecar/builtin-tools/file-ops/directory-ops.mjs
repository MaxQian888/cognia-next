// directory_create + directory_delete — directory lifecycle.

import fsp from "node:fs/promises"
import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"

import { toolError, toolText } from "../safety.mjs"
import { statOrNull } from "../shared/fs-stat.mjs"

// ---- directory_create -----------------------------------------------------

const directoryCreateShape = {
  path: z.string().min(1).describe("Absolute path of the directory to create."),
  recursive: z.boolean().default(true).describe("Create parent directories as needed."),
}

async function execDirectoryCreate(args) {
  try {
    await fsp.mkdir(args.path, { recursive: args.recursive })
    return toolText({ path: args.path, created: true })
  } catch (err) {
    return toolError(err, "directory_create")
  }
}

export const directoryCreateTool = tool(
  "directory_create",
  "Create a directory. Defaults to recursive (parents created if missing).",
  directoryCreateShape,
  execDirectoryCreate
)

// ---- directory_delete -----------------------------------------------------

const directoryDeleteShape = {
  path: z.string().min(1).describe("Absolute path of the directory to delete."),
  recursive: z
    .boolean()
    .default(false)
    .describe("Delete contents recursively. Required for non-empty directories."),
}

async function execDirectoryDelete(args) {
  try {
    const st = await statOrNull(args.path)
    if (!st) return toolError(`directory not found: ${args.path}`)
    if (!st.isDirectory()) return toolError(`not a directory: ${args.path}`)
    await fsp.rm(args.path, { recursive: args.recursive, force: false })
    return toolText({ path: args.path, deleted: true })
  } catch (err) {
    return toolError(err, "directory_delete")
  }
}

export const directoryDeleteTool = tool(
  "directory_delete",
  "Delete a directory. Set recursive=true to remove non-empty directories. HIGH-RISK — always requires user approval.",
  directoryDeleteShape,
  execDirectoryDelete
)

export { execDirectoryCreate, execDirectoryDelete }
