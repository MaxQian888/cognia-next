// file_copy + file_rename + file_move — relocate files on disk.

import fsp from "node:fs/promises"
import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"

import { toolError, toolText } from "../safety.mjs"
import { statOrNull } from "../shared/fs-stat.mjs"

// ---- file_copy ------------------------------------------------------------

const fileCopyShape = {
  source: z.string().min(1).describe("Absolute path of the source file."),
  destination: z.string().min(1).describe("Absolute path of the destination file."),
  overwrite: z.boolean().default(false).describe("Overwrite destination if it exists."),
}

async function execFileCopy(args) {
  try {
    if (!args.overwrite) {
      const exists = await statOrNull(args.destination)
      if (exists) return toolError(`destination already exists: ${args.destination}`)
    }
    await fsp.copyFile(args.source, args.destination)
    const st = await statOrNull(args.destination)
    return toolText({
      source: args.source,
      destination: args.destination,
      size: st?.size ?? null,
    })
  } catch (err) {
    return toolError(err, "file_copy")
  }
}

export const fileCopyTool = tool(
  "file_copy",
  "Copy a file from source to destination.",
  fileCopyShape,
  execFileCopy
)

// ---- file_rename ----------------------------------------------------------

const fileRenameShape = {
  oldPath: z.string().min(1).describe("Current absolute path."),
  newPath: z.string().min(1).describe("New absolute path."),
  overwrite: z.boolean().default(false).describe("Overwrite the destination if it exists."),
}

async function execFileRename(args) {
  try {
    // Guard against silently clobbering an existing file (matches file_copy).
    if (!args.overwrite) {
      const exists = await statOrNull(args.newPath)
      if (exists) return toolError(`destination already exists: ${args.newPath}`)
    }
    await fsp.rename(args.oldPath, args.newPath)
    return toolText({ oldPath: args.oldPath, newPath: args.newPath })
  } catch (err) {
    return toolError(err, "file_rename")
  }
}

export const fileRenameTool = tool(
  "file_rename",
  "Rename a file in place (atomic when source and destination share a filesystem). Refuses to overwrite an existing destination unless overwrite=true.",
  fileRenameShape,
  execFileRename
)

// ---- file_move ------------------------------------------------------------

const fileMoveShape = {
  source: z.string().min(1).describe("Absolute path of the file to move."),
  destination: z.string().min(1).describe("New absolute path."),
  overwrite: z.boolean().default(false).describe("Overwrite the destination if it exists."),
}

async function execFileMove(args) {
  try {
    // Guard against silently clobbering an existing file (matches file_copy).
    if (!args.overwrite) {
      const exists = await statOrNull(args.destination)
      if (exists) return toolError(`destination already exists: ${args.destination}`)
    }
    try {
      await fsp.rename(args.source, args.destination)
    } catch (err) {
      if (err.code === "EXDEV") {
        // Cross-device move: fall back to copy-then-delete.
        await fsp.copyFile(args.source, args.destination)
        await fsp.unlink(args.source)
      } else {
        throw err
      }
    }
    return toolText({ source: args.source, destination: args.destination })
  } catch (err) {
    return toolError(err, "file_move")
  }
}

export const fileMoveTool = tool(
  "file_move",
  "Move a file. Falls back to copy-then-delete across filesystems. Refuses to overwrite an existing destination unless overwrite=true.",
  fileMoveShape,
  execFileMove
)

export { execFileCopy, execFileRename, execFileMove }
