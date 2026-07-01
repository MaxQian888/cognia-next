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
import { resolveToolPath, formatCatN } from "./read.mjs"
import { diagnosticsAfterWrite } from "./write.mjs"

// Post-edit snippet (Claude Code parity): after a successful edit we echo the
// changed region as `cat -n` so the model can confirm the edit landed in the
// right place and in the right context WITHOUT a follow-up read. Context lines
// frame the change; very large insertions are head-clipped to keep the result
// compact.
export const SNIPPET_CONTEXT = 4
export const SNIPPET_MAX_LINES = 50

/**
 * Render the edited region of `content` (LF-normalized) as a `cat -n` block.
 *
 * @param {string} content   final file content, LF-normalized
 * @param {number} anchorIndex  char offset where the first replacement begins
 * @param {string} newText   the replacement text (LF-normalized); "" for a deletion
 * @returns {string} a labelled snippet block, or "" when the anchor is unknown
 */
export function renderEditSnippet(content, anchorIndex, newText) {
  if (!Number.isInteger(anchorIndex) || anchorIndex < 0) return ""
  const lines = content.split("\n")
  // 0-based line index of the anchor: count newlines before it.
  let startLine = 0
  for (let i = 0; i < anchorIndex && i < content.length; i++) {
    if (content[i] === "\n") startLine++
  }
  const insertedLines = newText.length === 0 ? 0 : newText.split("\n").length - 1
  const endLine = startLine + insertedLines
  const from = Math.max(0, startLine - SNIPPET_CONTEXT)
  let to = Math.min(lines.length - 1, endLine + SNIPPET_CONTEXT)
  let clipped = false
  if (to - from + 1 > SNIPPET_MAX_LINES) {
    to = from + SNIPPET_MAX_LINES - 1
    clipped = true
  }
  const window = lines.slice(from, to + 1)
  const body = formatCatN(window, from + 1)
  const note = clipped ? `\n… (${endLine - to} more changed line(s) not shown)` : ""
  return `\n\n${body}${note}`
}

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
        const snippet = renderEditSnippet(r.content, r.firstIndex, newLf)
        const diag = await diagnosticsAfterWrite(lspResolver, abs)
        return toolText(
          `Edited ${abs}: ${r.count} replacement${r.count === 1 ? "" : "s"}${via}.${snippet}${diag}`
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
        // Anchor the post-edit snippet on the FIRST edit, tracking how later
        // edits shift its position as the buffer mutates beneath it.
        let anchorIndex = null
        let anchorNewText = ""
        const applied = []
        for (let i = 0; i < args.edits.length; i++) {
          const e = args.edits[i]
          try {
            const oldLf = decodeText(e.old_string).content
            const newLf = decodeText(e.new_string).content
            const r = replaceWithFallback(content, oldLf, newLf, e.replace_all === true)
            if (anchorIndex === null) {
              anchorIndex = r.firstIndex
              anchorNewText = newLf
            } else {
              // r.targets are in the same coordinate space as the current
              // anchor (the buffer before this edit). Shift the anchor past
              // every replacement that ends at or before it.
              for (const t of r.targets) {
                if (t.start + t.oldLen <= anchorIndex) anchorIndex += r.newLen - t.oldLen
                else if (t.start < anchorIndex) anchorIndex = t.start
              }
            }
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
        const snippet = renderEditSnippet(content, anchorIndex ?? -1, anchorNewText)
        const diag = await diagnosticsAfterWrite(lspResolver, abs)
        return toolText(
          `Edited ${abs} with ${args.edits.length} edits:\n${applied.join("\n")}${snippet}${diag}`
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
