/**
 * Extract readable text from a binary/rich document (docx, xlsx, pptx, odt,
 * epub, rtf, html) referenced by `@<path>`, reusing the shared `lib/document`
 * processor. NEVER used for PDF in the CLI (pdfjs is browser-only here) — the
 * caller routes `.pdf` through `pdf.ts` instead. Pure: fs + processor injected.
 */
import nodeFs from "node:fs"
import path from "node:path"

import { processDocumentAsync as realProcess } from "@cognia/document/document-processor"
import type { ProcessedDocument } from "@/types/document/document"

export interface RichDocDeps {
  readFileBytes?: (absPath: string) => ArrayBuffer
  isFile?: (absPath: string) => boolean
  processDocumentAsync?: (
    id: string,
    filename: string,
    data: ArrayBuffer
  ) => Promise<ProcessedDocument>
}

export type RichDocResult = { ok: true; text: string } | { ok: false }

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

export async function extractRichDocBlock(
  ref: string,
  cwd: string,
  deps: RichDocDeps = {}
): Promise<RichDocResult> {
  const readFileBytes = deps.readFileBytes ?? ((p: string) => toArrayBuffer(nodeFs.readFileSync(p)))
  const isFile =
    deps.isFile ??
    ((p: string) => {
      try {
        return nodeFs.statSync(p).isFile()
      } catch {
        return false
      }
    })
  const processDocumentAsync = deps.processDocumentAsync ?? realProcess

  const abs = path.isAbsolute(ref) ? ref : path.resolve(cwd, ref)
  if (!isFile(abs)) return { ok: false }
  try {
    const data = readFileBytes(abs)
    const processed = await processDocumentAsync(ref, path.basename(ref), data)
    const text = (processed.content ?? "").trim()
    if (!text) return { ok: false }
    return { ok: true, text: `<file path="${ref}">\n${text}\n</file>` }
  } catch {
    return { ok: false }
  }
}
