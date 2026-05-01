// File-system tools that extend the SDK's built-in Read/Write/Glob/Grep:
//   - file_hash, file_diff, file_info, file_search, content_search
//   - file_exists, file_append, file_binary_write
//   - file_copy, file_rename, file_move
//   - directory_create, directory_delete
//
// Approval handling is delegated to the parent (`canUseTool` in
// claude-host.mjs) — we just declare schemas and execute. The MCP server
// configuration in builtin-tools/index.mjs controls which of these get
// registered based on settings.builtinTools.fileExtras.

import path from "node:path"
import fs from "node:fs"
import fsp from "node:fs/promises"
import crypto from "node:crypto"
import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"
import { createPatch } from "diff"
import fastGlob from "fast-glob"

import { toolError, toolText } from "./safety.mjs"

// ---- Local helpers --------------------------------------------------------

const MAX_READ_BYTES = 100 * 1024 * 1024 // 100 MB hard cap (matches Cognia)
const MAX_DIFF_BYTES = 5 * 1024 * 1024 // 5 MB per side; bigger files refuse the diff
const MAX_LIST_ITEMS = 5000
const MAX_CONTENT_MATCH_RESULTS = 500

const MIME_BY_EXT = new Map([
  [".txt", "text/plain"],
  [".md", "text/markdown"],
  [".json", "application/json"],
  [".js", "text/javascript"],
  [".mjs", "text/javascript"],
  [".cjs", "text/javascript"],
  [".ts", "text/typescript"],
  [".tsx", "text/typescript"],
  [".jsx", "text/javascript"],
  [".html", "text/html"],
  [".css", "text/css"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".pdf", "application/pdf"],
  [".zip", "application/zip"],
  [".tar", "application/x-tar"],
  [".gz", "application/gzip"],
  [".wasm", "application/wasm"],
  [".rs", "text/rust"],
  [".go", "text/x-go"],
  [".py", "text/x-python"],
  [".rb", "text/x-ruby"],
  [".java", "text/x-java"],
  [".c", "text/x-c"],
  [".h", "text/x-c"],
  [".cpp", "text/x-c++"],
  [".hpp", "text/x-c++"],
  [".sh", "application/x-sh"],
  [".toml", "application/toml"],
  [".yaml", "application/yaml"],
  [".yml", "application/yaml"],
])

function mimeForPath(p) {
  const ext = path.extname(p).toLowerCase()
  return MIME_BY_EXT.get(ext) ?? "application/octet-stream"
}

async function statOrNull(p) {
  try {
    return await fsp.stat(p)
  } catch {
    return null
  }
}

async function ensureExists(p) {
  const st = await statOrNull(p)
  if (!st) throw new Error(`file not found: ${p}`)
  return st
}

// ---- file_hash ------------------------------------------------------------

const fileHashShape = {
  path: z.string().min(1).describe("Absolute path to the file to hash."),
  algorithm: z
    .enum(["md5", "sha1", "sha256", "sha512"])
    .default("sha256")
    .describe("Hash algorithm. Defaults to sha256."),
}

async function execFileHash(args) {
  try {
    const st = await ensureExists(args.path)
    if (!st.isFile()) return toolError(`not a regular file: ${args.path}`)
    if (st.size > MAX_READ_BYTES) {
      return toolError(`file too large for hashing: ${st.size} bytes`)
    }
    const hash = crypto.createHash(args.algorithm)
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(args.path)
      stream.on("data", (chunk) => hash.update(chunk))
      stream.on("end", () => resolve(undefined))
      stream.on("error", reject)
    })
    return toolText({
      path: args.path,
      algorithm: args.algorithm,
      digest: hash.digest("hex"),
      size: st.size,
    })
  } catch (err) {
    return toolError(err, "file_hash")
  }
}

export const fileHashTool = tool(
  "file_hash",
  "Compute a cryptographic hash of a file (md5/sha1/sha256/sha512). Read-only.",
  fileHashShape,
  execFileHash,
  { alwaysLoad: true }
)

// ---- file_diff ------------------------------------------------------------

const fileDiffShape = {
  pathA: z.string().min(1).describe("Absolute path to the original file."),
  pathB: z.string().min(1).describe("Absolute path to the modified file."),
  context: z
    .number()
    .int()
    .min(0)
    .max(20)
    .default(3)
    .describe("Number of context lines around each hunk."),
}

async function execFileDiff(args) {
  try {
    const [stA, stB] = await Promise.all([ensureExists(args.pathA), ensureExists(args.pathB)])
    if (!stA.isFile() || !stB.isFile()) {
      return toolError("both inputs must be regular files")
    }
    if (stA.size > MAX_DIFF_BYTES || stB.size > MAX_DIFF_BYTES) {
      return toolError("file too large to diff (> 5 MB)")
    }
    const [a, b] = await Promise.all([
      fsp.readFile(args.pathA, "utf-8"),
      fsp.readFile(args.pathB, "utf-8"),
    ])
    const patch = createPatch(args.pathA, a, b, "", "", { context: args.context })
    return toolText(patch)
  } catch (err) {
    return toolError(err, "file_diff")
  }
}

export const fileDiffTool = tool(
  "file_diff",
  "Produce a unified diff between two files (read-only). Returns the patch text.",
  fileDiffShape,
  execFileDiff,
  { alwaysLoad: true }
)

// ---- file_info ------------------------------------------------------------

const fileInfoShape = {
  path: z.string().min(1).describe("Absolute path to inspect."),
}

async function execFileInfo(args) {
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

async function execFileExists(args) {
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

// ---- file_search ----------------------------------------------------------

const fileSearchShape = {
  directory: z.string().min(1).describe("Absolute root directory to search."),
  pattern: z
    .string()
    .optional()
    .describe(
      "Glob pattern (e.g., '**/*.ts'). When omitted lists every entry under the directory."
    ),
  extensions: z
    .array(z.string())
    .optional()
    .describe("Filter to files with these extensions (e.g., ['ts','tsx'])."),
  recursive: z.boolean().default(true).describe("Whether to recurse into subdirectories."),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIST_ITEMS)
    .default(200)
    .describe("Hard cap on returned entries."),
}

async function execFileSearch(args) {
  try {
    const root = path.resolve(args.directory)
    const st = await statOrNull(root)
    if (!st || !st.isDirectory()) return toolError(`not a directory: ${root}`)
    const patterns = args.pattern ? [args.pattern] : args.recursive ? ["**/*"] : ["*"]
    const entries = await fastGlob(patterns, {
      cwd: root,
      onlyFiles: true,
      dot: true,
      followSymbolicLinks: false,
      deep: args.recursive ? Infinity : 1,
      suppressErrors: true,
    })
    const filtered = args.extensions?.length
      ? entries.filter((p) => {
          const ext = path.extname(p).replace(/^\./, "").toLowerCase()
          return args.extensions.some((e) => e.toLowerCase() === ext)
        })
      : entries
    const sliced = filtered.slice(0, args.maxResults)
    return toolText({
      root,
      pattern: args.pattern ?? null,
      total: filtered.length,
      truncated: filtered.length > sliced.length,
      results: sliced,
    })
  } catch (err) {
    return toolError(err, "file_search")
  }
}

export const fileSearchTool = tool(
  "file_search",
  "List files under a directory matching an optional glob pattern and extension filter. Read-only.",
  fileSearchShape,
  execFileSearch
)

// ---- content_search -------------------------------------------------------

const contentSearchShape = {
  directory: z.string().min(1).describe("Absolute root directory to search."),
  pattern: z.string().min(1).describe("Substring or regex to search for."),
  regex: z.boolean().default(false).describe("Treat pattern as a regular expression."),
  caseSensitive: z.boolean().default(false).describe("Match case-sensitively."),
  extensions: z.array(z.string()).optional().describe("Restrict to these file extensions."),
  recursive: z.boolean().default(true).describe("Walk subdirectories."),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(MAX_CONTENT_MATCH_RESULTS)
    .default(100)
    .describe("Cap on the number of match rows returned."),
}

async function execContentSearch(args) {
  try {
    const root = path.resolve(args.directory)
    const rootStat = await statOrNull(root)
    if (!rootStat || !rootStat.isDirectory()) return toolError(`not a directory: ${root}`)
    const flags = args.caseSensitive ? "" : "i"
    const matcher = args.regex
      ? new RegExp(args.pattern, flags)
      : new RegExp(args.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags)
    const fileEntries = await fastGlob(args.recursive ? "**/*" : "*", {
      cwd: root,
      onlyFiles: true,
      dot: false,
      followSymbolicLinks: false,
      suppressErrors: true,
    })
    const allowedExts = args.extensions?.map((e) => e.toLowerCase().replace(/^\./, ""))
    const matches = []
    for (const rel of fileEntries) {
      if (allowedExts?.length) {
        const ext = path.extname(rel).replace(/^\./, "").toLowerCase()
        if (!allowedExts.includes(ext)) continue
      }
      const abs = path.join(root, rel)
      const stat = await statOrNull(abs)
      if (!stat || stat.size > MAX_DIFF_BYTES) continue
      let content
      try {
        content = await fsp.readFile(abs, "utf-8")
      } catch {
        continue
      }
      const lines = content.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        if (matcher.test(lines[i])) {
          matches.push({ file: rel, line: i + 1, text: lines[i].slice(0, 400) })
          if (matches.length >= args.maxResults) {
            return toolText({
              root,
              pattern: args.pattern,
              matches,
              truncated: true,
            })
          }
        }
      }
    }
    return toolText({ root, pattern: args.pattern, matches, truncated: false })
  } catch (err) {
    return toolError(err, "content_search")
  }
}

export const contentSearchTool = tool(
  "content_search",
  "Search file contents under a directory for a substring or regex. Read-only. Returns line numbers.",
  contentSearchShape,
  execContentSearch
)

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

const fileBinaryWriteShape = {
  path: z.string().min(1).describe("Absolute path to write."),
  data: z.string().min(1).describe("Base64-encoded binary content."),
  createDirectories: z.boolean().default(false).describe("Create parent directories if missing."),
}

async function execFileBinaryWrite(args) {
  try {
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
}

async function execFileRename(args) {
  try {
    await fsp.rename(args.oldPath, args.newPath)
    return toolText({ oldPath: args.oldPath, newPath: args.newPath })
  } catch (err) {
    return toolError(err, "file_rename")
  }
}

export const fileRenameTool = tool(
  "file_rename",
  "Rename a file in place (atomic when source and destination share a filesystem).",
  fileRenameShape,
  execFileRename
)

// ---- file_move ------------------------------------------------------------

const fileMoveShape = {
  source: z.string().min(1).describe("Absolute path of the file to move."),
  destination: z.string().min(1).describe("New absolute path."),
}

async function execFileMove(args) {
  try {
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
  "Move a file. Falls back to copy-then-delete across filesystems.",
  fileMoveShape,
  execFileMove
)

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

// ---- Exports --------------------------------------------------------------

/** All file-extras tool definitions. Used by builtin-tools/index.mjs. */
export const fileExtrasTools = [
  fileHashTool,
  fileDiffTool,
  fileInfoTool,
  fileExistsTool,
  fileSearchTool,
  contentSearchTool,
  fileAppendTool,
  fileBinaryWriteTool,
  fileCopyTool,
  fileRenameTool,
  fileMoveTool,
  directoryCreateTool,
  directoryDeleteTool,
]

/** Test-only: handler exports so the test suite can hit them without going
 *  through the SDK transport. */
export const __testExports = {
  execFileHash,
  execFileDiff,
  execFileInfo,
  execFileExists,
  execFileSearch,
  execContentSearch,
  execFileAppend,
  execFileBinaryWrite,
  execFileCopy,
  execFileRename,
  execFileMove,
  execDirectoryCreate,
  execDirectoryDelete,
  mimeForPath,
}
