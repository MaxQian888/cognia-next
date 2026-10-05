// file_info + file_exists — path metadata (read-only).

import { z } from "zod"

import { toolError, toolText } from "../../kernel/result.ts"
import { statOrNull } from "../../../platform/fs/stat.ts"
import { mimeForPath } from "../../../shared/mime.ts"
import { tool, type ToolArgs } from "../../kernel/define.ts"

// ---- file_info ------------------------------------------------------------

const fileInfoShape = {
  path: z.string().min(1).describe("Absolute path to inspect."),
}

async function execFileInfo(args: ToolArgs<typeof fileInfoShape>) {
  try {
    const st = await statOrNull(args.path)
    if (!st) return toolText({ path: args.path, exists: false })
    return toolText({
      path: args.path,
      exists: true,
      isFile: st.isFile(),
      isDirectory: st.isDirectory(),
      isSymbolicLink: st.isSymbolicLink(),
      size: st.size,
      mtime: st.mtime.toISOString(),
      ctime: st.ctime.toISOString(),
      mode: st.mode,
      mime: st.isFile() ? mimeForPath(args.path) : undefined,
    })
  } catch (err) {
    return toolError(err, "file_info")
  }
}

export const fileInfoTool = tool(
  "file_info",
  "Get metadata for a path (size, mtime, mode, mime). Returns exists:false rather than erroring on missing paths.",
  fileInfoShape,
  execFileInfo,
  { alwaysLoad: true }
)

// ---- file_exists ----------------------------------------------------------

const fileExistsShape = {
  path: z.string().min(1).describe("Absolute path to test."),
}

async function execFileExists(args: ToolArgs<typeof fileExistsShape>) {
  try {
    const st = await statOrNull(args.path)
    return toolText({ path: args.path, exists: st !== null })
  } catch (err) {
    return toolError(err, "file_exists")
  }
}

export const fileExistsTool = tool(
  "file_exists",
  "Check if a path exists (file or directory). Read-only.",
  fileExistsShape,
  execFileExists,
  { alwaysLoad: true }
)

export { execFileInfo, execFileExists }
