// Core `read` tool — Claude Code-compatible file reader for the ai-sdk path.
//
// cat -n style numbering, offset/limit windowing, per-line and total output
// caps with continuation hints, directory listings, and binary detection.
// Every successful file read is recorded into the session read-tracker so
// write/edit can enforce read-before-write.

import path from "node:path"
import fsp from "node:fs/promises"
import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"

import { toolError, toolText, toolImage } from "../safety.mjs"
import { looksBinary } from "./js-search.mjs"
import { decodeText } from "./text-io.mjs"
import {
  imageMimeFor,
  modelSupportsImageInput,
  readImageBlock,
  renderNotebook,
} from "./read-media.mjs"

export const DEFAULT_LIMIT = 2000
export const MAX_LINE_CHARS = 2000
export const MAX_OUTPUT_BYTES = 256 * 1024

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg"])

export const readShape = {
  file_path: z
    .string()
    .min(1)
    .describe("Path to the file to read (absolute, or relative to the session working directory)."),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "1-based line number to start reading from. Use with limit to page through large files."
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(`Maximum number of lines to read (default ${DEFAULT_LIMIT}).`),
}

/** Resolve a possibly-relative tool path against the session cwd. */
export function resolveToolPath(cwd, p) {
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd ?? process.cwd(), p)
}

export function formatCatN(lines, startLine) {
  return lines
    .map((line, i) => {
      const text =
        line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… (line truncated)` : line
      return `${String(startLine + i).padStart(6)}\t${text}`
    })
    .join("\n")
}

export function createReadTool({ cwd, readTracker, model, provider } = {}) {
  async function execRead(args) {
    try {
      const abs = resolveToolPath(cwd, args.file_path)
      let st
      try {
        st = await fsp.stat(abs)
      } catch {
        return toolError(`file not found: ${abs}`)
      }

      const ext = path.extname(abs).toLowerCase()

      // Jupyter notebook — render cells as readable text instead of raw JSON.
      if (st.isFile() && ext === ".ipynb") {
        try {
          const raw = await fsp.readFile(abs, "utf-8")
          const rendered = renderNotebook(raw)
          readTracker?.record(abs, st)
          return toolText(rendered)
        } catch (err) {
          return toolError(`could not parse notebook ${abs}: ${err?.message ?? err}`)
        }
      }

      // Image — return a real image content block when the model accepts
      // images; otherwise an honest redirect (the @-attachment pipeline and
      // vision-capable models are the supported paths).
      if (st.isFile() && imageMimeFor(abs)) {
        if (modelSupportsImageInput(provider, model)) {
          const img = await readImageBlock(abs)
          if (img.ok) {
            readTracker?.record(abs, st)
            return toolImage(img.data, img.mimeType, `${abs} (${img.size} bytes)`)
          }
          if (img.reason === "too_large") {
            return toolText(
              `${abs} is an image but exceeds the inline limit (${img.size} bytes). Use file_info / file_hash for metadata.`
            )
          }
        }
        return toolText(
          `${abs} is an image file (${st.size} bytes). The active model cannot accept image input — switch to a vision-capable model or attach it with @${args.file_path} in your message.`
        )
      }

      // PDF — MCP tool results carry no document type, so direct the caller to
      // the @-attachment pipeline (which sends a native PDF block) instead.
      if (st.isFile() && ext === ".pdf") {
        return toolText(
          `${abs} is a PDF (${st.size} bytes). The read tool cannot inline PDFs; attach it with @${args.file_path} in your message to send it as a document, or use file_info for metadata.`
        )
      }

      if (st.isDirectory()) {
        const entries = await fsp.readdir(abs, { withFileTypes: true })
        entries.sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
          return a.name < b.name ? -1 : 1
        })
        const listing = entries.slice(0, 500).map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        const note =
          entries.length > 500
            ? `\n… ${entries.length - 500} more entries (use ls with a deeper path)`
            : ""
        return toolText(`${abs} is a directory. Contents:\n${listing.join("\n")}${note}`)
      }
      if (!st.isFile()) return toolError(`not a regular file: ${abs}`)

      const buf = await fsp.readFile(abs)
      if (looksBinary(buf)) {
        const ext = path.extname(abs).toLowerCase()
        const kind = IMAGE_EXTS.has(ext) ? "an image" : "a binary"
        return toolText(
          `${abs} is ${kind} file (${st.size} bytes). The core read tool cannot display its contents; use file_info or file_hash for metadata.`
        )
      }

      const { content } = decodeText(buf.toString("utf-8"))
      const allLines = content.split("\n")
      const start = args.offset ?? 1
      const limit = args.limit ?? DEFAULT_LIMIT
      if (start > allLines.length) {
        return toolError(`offset ${start} is beyond the end of the file (${allLines.length} lines)`)
      }
      const window = allLines.slice(start - 1, start - 1 + limit)

      let body = formatCatN(window, start)
      let clipped = false
      if (Buffer.byteLength(body, "utf-8") > MAX_OUTPUT_BYTES) {
        // Trim whole lines until the body fits.
        const out = []
        let bytes = 0
        for (const line of body.split("\n")) {
          const b = Buffer.byteLength(line, "utf-8") + 1
          if (bytes + b > MAX_OUTPUT_BYTES) break
          out.push(line)
          bytes += b
        }
        clipped = true
        body = out.join("\n")
      }
      const shownLines = clipped ? body.split("\n").length : window.length
      const lastShown = start + shownLines - 1
      const hasMore = lastShown < allLines.length
      const hint = hasMore
        ? `\n\n(showing lines ${start}-${lastShown} of ${allLines.length}; continue with offset=${lastShown + 1})`
        : ""

      // Record the read for read-before-write enforcement.
      readTracker?.record(abs, st)

      return toolText(`${body}${hint}`)
    } catch (err) {
      return toolError(err, "read")
    }
  }

  return tool(
    "read",
    "Read a text file with line numbers (cat -n style). Supports offset/limit paging for large files; lists directories; detects binary files. Always read a file before editing it.",
    readShape,
    execRead,
    { alwaysLoad: true }
  )
}
