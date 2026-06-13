/**
 * Decide how to attach a `@<path>.pdf` reference:
 *   - active model accepts PDF input (Claude, or any models.dev model whose
 *     `modalities.input` includes "pdf") → native base64 `document` block;
 *   - otherwise → OCR the PDF to text (Claude vision via the Node-safe runner)
 *     and fold it into the prompt as a `<file>` block.
 * Pure: fs + OCR runner injected for unit testing.
 */
import nodeFs from "node:fs"
import path from "node:path"

import type { SendContentBlock } from "@/lib/claude/types"
import { modelSupportsPdfInput } from "./model-modalities"
import { ocrExtractText, type OcrRunResult } from "./ocr"

export interface PdfDeps {
  isAnthropic: boolean
  provider: string
  model: string
  /** Resolves the Anthropic API key for the OCR fallback. */
  anthropicKey?: () => string | null
  readFileBytes?: (absPath: string) => ArrayBuffer
  isFile?: (absPath: string) => boolean
  /** Injectable OCR runner; defaults to `ocrExtractText`. */
  runOcr?: (data: ArrayBuffer, mimeType: string) => Promise<OcrRunResult>
}

export type PdfResolution =
  | { kind: "block"; block: Extract<SendContentBlock, { type: "document" }> }
  | { kind: "text"; text: string }
  | { kind: "failed"; reason?: string }

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

export async function resolvePdfRef(
  ref: string,
  cwd: string,
  deps: PdfDeps
): Promise<PdfResolution> {
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

  const abs = path.isAbsolute(ref) ? ref : path.resolve(cwd, ref)
  if (!isFile(abs)) return { kind: "failed" }
  let data: ArrayBuffer
  try {
    data = readFileBytes(abs)
  } catch {
    return { kind: "failed" }
  }

  const native = deps.isAnthropic || modelSupportsPdfInput(deps.provider, deps.model)
  if (native) {
    const base64 = Buffer.from(new Uint8Array(data)).toString("base64")
    return {
      kind: "block",
      block: {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: base64 },
      },
    }
  }

  const runOcr =
    deps.runOcr ??
    ((d: ArrayBuffer, mime: string) =>
      ocrExtractText(d, mime, { anthropicKey: deps.anthropicKey ?? (() => null) }))
  const ocr = await runOcr(data, "application/pdf")
  if (ocr.ok) return { kind: "text", text: `<file path="${ref}">\n${ocr.text}\n</file>` }
  return { kind: "failed", reason: ocr.reason }
}
