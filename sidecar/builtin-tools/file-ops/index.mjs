// Assembler for the `fileExtras` builtin category — extended filesystem tools
// that complement the SDK's built-in Read/Write/Glob/Grep.
//
// Tools are emitted in the FIXED order of FILE_EXTRAS_TOOL_NAMES: the serialized
// tool list feeds provider prompt-cache prefix matching, so registration order
// must stay byte-stable across turns and sessions. New tools are APPENDED.

import { mimeForPath } from "../shared/mime.mjs"

import { fileHashTool, execFileHash } from "./file-hash.mjs"
import { fileDiffTool, execFileDiff } from "./file-diff.mjs"
import { fileInfoTool, fileExistsTool, execFileInfo, execFileExists } from "./file-stat.mjs"
import { fileSearchTool, execFileSearch } from "./file-search.mjs"
import { contentSearchTool, execContentSearch } from "./content-search.mjs"
import {
  fileAppendTool,
  fileBinaryWriteTool,
  execFileAppend,
  execFileBinaryWrite,
} from "./file-write.mjs"
import {
  fileCopyTool,
  fileRenameTool,
  fileMoveTool,
  execFileCopy,
  execFileRename,
  execFileMove,
} from "./file-transfer.mjs"
import {
  directoryCreateTool,
  directoryDeleteTool,
  execDirectoryCreate,
  execDirectoryDelete,
} from "./directory-ops.mjs"

/** Fixed registration order — do not reorder (prompt-cache stability). */
export const FILE_EXTRAS_TOOL_NAMES = Object.freeze([
  "file_hash",
  "file_diff",
  "file_info",
  "file_exists",
  "file_search",
  "content_search",
  "file_append",
  "file_binary_write",
  "file_copy",
  "file_rename",
  "file_move",
  "directory_create",
  "directory_delete",
])

/** All file-extras tool definitions, in FILE_EXTRAS_TOOL_NAMES order. */
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

// Defensive: the emitted order must match the public constant.
for (let i = 0; i < fileExtrasTools.length; i++) {
  if (fileExtrasTools[i].name !== FILE_EXTRAS_TOOL_NAMES[i]) {
    throw new Error(
      `file-extras tool order drift: expected ${FILE_EXTRAS_TOOL_NAMES[i]}, got ${fileExtrasTools[i].name}`
    )
  }
}

/** Test-only: handler exports so the suite can hit them without the SDK transport. */
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
