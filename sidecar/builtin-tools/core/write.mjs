// Core `write` tool — full-file create/overwrite with read-before-overwrite
// enforcement, BOM/EOL preservation, per-file serialization, and best-effort
// LSP diagnostics feedback after the write.

import path from "node:path"
import fsp from "node:fs/promises"
import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"

import { toolError, toolText } from "../safety.mjs"
import { canonicalKey } from "./read-tracker.mjs"
import { decodeText, encodeText, withFileLock } from "./text-io.mjs"
import { resolveToolPath } from "./read.mjs"

export const LSP_DIAG_TIMEOUT_MS = 3_000
export const LSP_DIAG_MAX_CHARS = 4_000

export const writeShape = {
  file_path: z
    .string()
    .min(1)
    .describe(
      "Path of the file to write (absolute, or relative to the session working directory)."
    ),
  content: z.string().describe("Full content to write. Overwrites the existing file entirely."),
}

/**
 * Best-effort diagnostics block after a mutation. Never throws; returns ""
 * when LSP is unavailable, slow, or clean.
 */
export async function diagnosticsAfterWrite(lspResolver, absPath) {
  if (!lspResolver || typeof lspResolver.getDiagnostics !== "function") return ""
  try {
    const diags = await Promise.race([
      lspResolver.getDiagnostics(absPath),
      new Promise((resolve) => setTimeout(() => resolve(null), LSP_DIAG_TIMEOUT_MS)),
    ])
    if (!Array.isArray(diags) || diags.length === 0) return ""
    const { formatDiagnostics } = await import("../../lsp/report.mjs")
    const block = formatDiagnostics(absPath, diags, { minSeverity: 2 })
    if (!block) return ""
    const clipped =
      block.length > LSP_DIAG_MAX_CHARS ? `${block.slice(0, LSP_DIAG_MAX_CHARS)}…` : block
    return `\n\nDiagnostics after write:\n${clipped}`
  } catch {
    return ""
  }
}

export function createWriteTool({ cwd, readTracker, lspResolver }) {
  async function execWrite(args) {
    try {
      const abs = resolveToolPath(cwd, args.file_path)
      return await withFileLock(canonicalKey(abs), async () => {
        let existing = null
        try {
          existing = await fsp.stat(abs)
        } catch {
          existing = null
        }
        if (existing) {
          if (!existing.isFile()) return toolError(`not a regular file: ${abs}`)
          // Overwrites of existing files require a prior read this session.
          readTracker?.assertReadBefore(abs, existing)
        }

        // Preserve the existing file's BOM/EOL traits; new files are written
        // verbatim (LF unless the content itself carries CRLF).
        let payload = args.content
        if (existing) {
          const raw = await fsp.readFile(abs, "utf-8")
          const traits = decodeText(raw)
          payload = encodeText(decodeText(args.content).content, traits)
        }

        await fsp.mkdir(path.dirname(abs), { recursive: true })
        await fsp.writeFile(abs, payload, "utf-8")
        const st = await fsp.stat(abs)
        readTracker?.record(abs, st)

        const lineCount = decodeText(args.content).content.split("\n").length
        const diag = await diagnosticsAfterWrite(lspResolver, abs)
        return toolText(`${existing ? "Updated" : "Created"} ${abs} (${lineCount} lines).${diag}`)
      })
    } catch (err) {
      return toolError(err, "write")
    }
  }

  return tool(
    "write",
    "Create a new file or overwrite an existing one with the given content. Overwriting requires the file to have been read this session.",
    writeShape,
    execWrite
  )
}
