// Core `NotebookEdit` tool — per-cell editing of Jupyter notebooks (.ipynb).
//
// Claude Code parity counterpart to the read tool's `.ipynb` rendering: where
// `read` shows a notebook's cells as text, `NotebookEdit` mutates a single cell
// (replace / insert / delete). Like `edit`/`write` it enforces read-before-write
// via the session read-tracker and serialises per-file with withFileLock.

import fsp from "node:fs/promises"
import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"

import { toolError, toolText } from "../safety.mjs"
import { assertNotSecretEscape } from "../confinement.mjs"
import { canonicalKey } from "./read-tracker.mjs"
import { withFileLock } from "./text-io.mjs"
import { resolveToolPath } from "./read.mjs"
import { editNotebook } from "./read-media.mjs"

export const NOTEBOOK_EDIT_NAME = "NotebookEdit"

export const notebookEditShape = {
  file_path: z
    .string()
    .min(1)
    .describe(
      "Path to the .ipynb notebook (absolute, or relative to the session working directory)."
    ),
  cell_id: z
    .string()
    .optional()
    .describe(
      "nbformat id of the cell to target. Omit with edit_mode=insert to insert at the top."
    ),
  cell_number: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "1-based cell number to target, as shown by reading the notebook. Alternative to cell_id."
    ),
  new_source: z
    .string()
    .optional()
    .describe("New cell source. Required for replace and insert; ignored for delete."),
  cell_type: z
    .enum(["code", "markdown"])
    .optional()
    .describe(
      "Cell type. For insert defaults to code; for replace, changes the existing cell's type."
    ),
  edit_mode: z
    .enum(["replace", "insert", "delete"])
    .optional()
    .describe(
      "replace (default) overwrites a cell; insert adds a new cell; delete removes a cell."
    ),
}

export function createNotebookEditTool({ cwd, readTracker } = {}) {
  async function execNotebookEdit(args) {
    try {
      const abs = resolveToolPath(cwd, args.file_path)
      assertNotSecretEscape(cwd, abs)
      return await withFileLock(canonicalKey(abs), async () => {
        let st
        try {
          st = await fsp.stat(abs)
        } catch {
          return toolError(`notebook not found: ${abs}`)
        }
        if (!st.isFile()) return toolError(`not a regular file: ${abs}`)
        // Mutating a notebook requires a prior read this session (read-before-write).
        readTracker?.assertReadBefore(abs, st)

        const raw = await fsp.readFile(abs, "utf-8")
        let result
        try {
          result = editNotebook(raw, {
            cellId: args.cell_id,
            cellNumber: args.cell_number,
            cellType: args.cell_type,
            source: args.new_source,
            mode: args.edit_mode ?? "replace",
          })
        } catch (err) {
          return toolError(err, "NotebookEdit")
        }

        // Preserve a trailing newline if the original had one.
        const json = raw.endsWith("\n") ? `${result.json}\n` : result.json
        await fsp.writeFile(abs, json, "utf-8")
        const newSt = await fsp.stat(abs)
        readTracker?.record(abs, newSt)
        return toolText(`${result.message} (${abs})`)
      })
    } catch (err) {
      return toolError(err, "NotebookEdit")
    }
  }

  return tool(
    NOTEBOOK_EDIT_NAME,
    "Edit a single cell of a Jupyter notebook (.ipynb): replace a cell's source, insert a new cell, or delete a cell. Read the notebook first. Locate the cell by cell_id or 1-based cell_number.",
    notebookEditShape,
    execNotebookEdit
  )
}
