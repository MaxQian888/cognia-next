// file_diff — unified diff between two files (read-only).

import fsp from "node:fs/promises"
import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"
import { createPatch } from "diff"

import { toolError, toolText } from "../safety.mjs"
import { ensureExists } from "../shared/fs-stat.mjs"
import { headTruncate } from "../shared/truncate.mjs"

const MAX_DIFF_BYTES = 5 * 1024 * 1024 // 5 MB per side; bigger files refuse the diff
// Two near-5 MB files can produce a multi-MB patch; cap the model-facing text
// (git_diff does the same via trimTail) so a single diff can't flood context.
const MAX_PATCH_CHARS = 256 * 1024

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
    const { text, truncated } = headTruncate(patch, MAX_PATCH_CHARS)
    const guidance = truncated
      ? "\n(diff truncated — the files differ by more than 256 KB; diff smaller regions or use a lower context.)"
      : ""
    return toolText(`${text}${guidance}`)
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

export { execFileDiff }
