// file_append + file_binary_write — write helpers beyond the SDK's Write tool.

import path from "node:path"
import fsp from "node:fs/promises"
import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"

import { assertNotSecretEscape } from "../confinement.mjs"
import { toolError, toolText } from "../safety.mjs"
import { statOrNull } from "../shared/fs-stat.mjs"

// ---- file_append ----------------------------------------------------------

const fileAppendShape = {
  path: z.string().min(1).describe("Absolute path to the target file."),
  content: z.string().describe("Text to append. UTF-8."),
  ensureTrailingNewline: z
    .boolean()
    .default(false)
    .describe("Append a final newline if the content doesn't already end with one."),
}

async function execFileAppend(args) {
  try {
    // Tool-body backstop: these tools carry absolute paths and are auto-approved
    // in `acceptEdits`, so the credential deny must hold here too.
    assertNotSecretEscape(undefined, args.path)
    let payload = args.content
    if (args.ensureTrailingNewline && !payload.endsWith("\n")) payload += "\n"
    await fsp.appendFile(args.path, payload, "utf-8")
    const st = await statOrNull(args.path)
    return toolText({
      path: args.path,
      bytesAppended: Buffer.byteLength(payload, "utf-8"),
      newSize: st?.size ?? null,
    })
  } catch (err) {
    return toolError(err, "file_append")
  }
}

export const fileAppendTool = tool(
  "file_append",
  "Append text to a file (UTF-8). Creates the file if it doesn't exist.",
  fileAppendShape,
  execFileAppend
)

// ---- file_binary_write ----------------------------------------------------

// Upper bound on the decoded payload. Mirrors the read-side `file_hash` 100 MB
// cap so the write side can't be handed an unbounded base64 blob that
// allocates a huge Buffer before any I/O. Checked against the base64 LENGTH
// (≈ 4/3 of the decoded size) so we reject BEFORE decoding.
export const MAX_BINARY_WRITE_BYTES = 100 * 1024 * 1024

/**
 * True when a base64 string of the given length would decode to more than
 * {@link MAX_BINARY_WRITE_BYTES}. Pure + length-based so the check (and its
 * test) never allocates the payload.
 */
export function exceedsBinaryWriteLimit(base64Length) {
  return Math.floor((base64Length * 3) / 4) > MAX_BINARY_WRITE_BYTES
}

const fileBinaryWriteShape = {
  path: z.string().min(1).describe("Absolute path to write."),
  data: z.string().min(1).describe("Base64-encoded binary content (≤100 MB decoded)."),
  createDirectories: z.boolean().default(false).describe("Create parent directories if missing."),
}

async function execFileBinaryWrite(args) {
  try {
    // Reject early so a multi-hundred-MB blob never reaches Buffer.from.
    if (exceedsBinaryWriteLimit(args.data.length)) {
      const estimatedMB = Math.round((args.data.length * 3) / 4 / 1024 / 1024)
      return toolError(
        `payload too large: ~${estimatedMB} MB exceeds the ${MAX_BINARY_WRITE_BYTES / 1024 / 1024} MB limit`,
        "file_binary_write"
      )
    }
    assertNotSecretEscape(undefined, args.path)
    if (args.createDirectories) {
      const parent = path.dirname(args.path)
      await fsp.mkdir(parent, { recursive: true })
    }
    const bytes = Buffer.from(args.data, "base64")
    await fsp.writeFile(args.path, bytes)
    return toolText({ path: args.path, bytesWritten: bytes.byteLength })
  } catch (err) {
    return toolError(err, "file_binary_write")
  }
}

export const fileBinaryWriteTool = tool(
  "file_binary_write",
  "Write base64-encoded binary data to a file. Use Read/Write for text instead.",
  fileBinaryWriteShape,
  execFileBinaryWrite
)

export { execFileAppend, execFileBinaryWrite }
