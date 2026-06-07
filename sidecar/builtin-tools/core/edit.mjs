// Core `edit` + `multi_edit` tools — exact-string replacement with the
// opencode-style fuzzy fallback cascade (fuzzy-replace.mjs), read-before-edit
// enforcement, BOM/EOL preservation, per-file serialization, and best-effort
// LSP diagnostics after the edit. `multi_edit` applies its edits sequentially
// against an in-memory buffer and aborts atomically on the first failure.

import fsp from "node:fs/promises"
import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"

import { toolError, toolText } from "../safety.mjs"
import { canonicalKey } from "./read-tracker.mjs"
import { decodeText, encodeText, withFileLock } from "./text-io.mjs"
import { replaceWithFallback } from "./fuzzy-replace.mjs"
import { resolveToolPath } from "./read.mjs"
import { diagnosticsAfterWrite } from "./write.mjs"

export const editShape = {
  file_path: z
    .string()
    .min(1)
    .describe("Path of the file to edit (absolute, or relative to the session working directory)."),
  old_string: z
    .string()
    .min(1)
    .describe(
      "The exact text to replace. Copy it from a fresh read of the file, including indentation."
    ),
  new_string: z.string().describe("The replacement text (must differ from old_string)."),
  replace_all: z
    .boolean()
    .optional()
    .describe("Replace every occurrence instead of requiring a unique match (default false)."),
}

export const multiEditShape = {
  file_path: z
    .string()
    .min(1)
    .describe("Path of the file to edit (absolute, or relative to the session working directory)."),
  edits: z
    .array(
      z.object({
        old_string: z.string().min(1).describe("The exact text to replace."),
        new_string: z.string().describe("The replacement text."),
        replace_all: z
          .boolean()
          .optional()
          .describe("Replace every occurrence of this edit's old_string."),
      })
    )
    .min(1)
    .describe(
      "Edits applied in order against the result of the previous edit. The whole batch fails atomically."
    ),
}

async function loadForEdit(abs, readTracker) {
  let st
  try {
    st = await fsp.stat(abs)
  } catch {
    throw new Error(`file not found: ${abs}`)
  }
  if (!st.isFile()) throw new Error(`not a regular file: ${abs}`)
  readTracker?.assertReadBefore(abs, st)
  const raw = await fsp.readFile(abs, "utf-8")
  return decodeText(raw)
}

async function saveEdited(abs, content, traits, readTracker) {
  await fsp.writeFile(abs, encodeText(content, traits), "utf-8")
  const st = await fsp.stat(abs)
  readTracker?.record(abs, st)
}

export function createEditTool({ cwd, readTracker, lspResolver }) {
  async function execEdit(args) {
    try {
      const abs = resolveToolPath(cwd, args.file_path)
      return await withFileLock(canonicalKey(abs), async () => {
        const traits = await loadForEdit(abs, readTracker)
        // fuzzy-replace operates on LF-normalized text; the model's strings
        // are normalized the same way so CRLF drift never blocks a match.
        const oldLf = decodeText(args.old_string).content
        const newLf = decodeText(args.new_string).content
        const r = replaceWithFallback(traits.content, oldLf, newLf, args.replace_all === true)
        await saveEdited(abs, r.content, traits, readTracker)
        const via = r.matched === "exact" ? "" : ` (matched via ${r.matched})`
        const diag = await diagnosticsAfterWrite(lspResolver, abs)
        return toolText(
          `Edited ${abs}: ${r.count} replacement${r.count === 1 ? "" : "s"}${via}.${diag}`
        )
      })
    } catch (err) {
      return toolError(err, "edit")
    }
  }

  return tool(
    "edit",
    "Replace an exact string in a file. The match falls back through whitespace-tolerant strategies when the exact text is not found. Requires the file to have been read this session. Use replace_all for bulk renames.",
    editShape,
    execEdit
  )
}

export function createMultiEditTool({ cwd, readTracker, lspResolver }) {
  async function execMultiEdit(args) {
    try {
      const abs = resolveToolPath(cwd, args.file_path)
      return await withFileLock(canonicalKey(abs), async () => {
        const traits = await loadForEdit(abs, readTracker)
        let content = traits.content
        const applied = []
        for (let i = 0; i < args.edits.length; i++) {
          const e = args.edits[i]
          try {
            const oldLf = decodeText(e.old_string).content
            const newLf = decodeText(e.new_string).content
            const r = replaceWithFallback(content, oldLf, newLf, e.replace_all === true)
            content = r.content
            applied.push(
              `#${i + 1}: ${r.count} replacement${r.count === 1 ? "" : "s"}${r.matched === "exact" ? "" : ` (${r.matched})`}`
            )
          } catch (err) {
            // Atomic: nothing is written when any edit fails.
            return toolError(
              `edit #${i + 1} of ${args.edits.length} failed — no changes were written. ${err.message}`,
              "multi_edit"
            )
          }
        }
        await saveEdited(abs, content, traits, readTracker)
        const diag = await diagnosticsAfterWrite(lspResolver, abs)
        return toolText(
          `Edited ${abs} with ${args.edits.length} edits:\n${applied.join("\n")}${diag}`
        )
      })
    } catch (err) {
      return toolError(err, "multi_edit")
    }
  }

  return tool(
    "multi_edit",
    "Apply multiple string replacements to ONE file in a single atomic operation. Edits run in order against the result of the previous edit; if any edit fails nothing is written. Requires the file to have been read this session.",
    multiEditShape,
    execMultiEdit
  )
}
