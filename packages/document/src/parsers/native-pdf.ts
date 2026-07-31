/**
 * Native PDF parsing bridge — typed wrapper around the feature-gated Tauri
 * `parse_document_native` command (liteparse / PDFium, `src-tauri/src/parse/`).
 *
 * Returns the renderer's `PDFParseResult` shape with per-item bounding boxes
 * (`PDFPage.items`), which the pdfjs path cannot provide. Throws on ANY
 * failure so `parsePDF` can fall back to pdfjs — callers other than
 * `pdf-parser.ts` should not use this directly.
 *
 * The first `unsupported` error (feature not compiled in) is cached
 * module-level so subsequent PDFs skip the IPC round-trip entirely.
 */

import { documentTransport, isTauri } from "../runtime-adapters"
import type { PDFParseResult, PdfTextItem } from "../types"

/** Wire shape of the Rust `NativeParseDto` (camelCase serde). */
export interface NativeParseDto {
  pages: {
    pageNumber: number
    width: number
    height: number
    text: string
    items: PdfTextItem[]
    truncated: boolean
  }[]
  text: string
}

export interface NativePdfOptions {
  password?: string
  /** 1-based page numbers to parse; omitted = all pages. */
  targetPages?: number[]
}

/** Stable error-code prefix emitted by the Rust stub when the
 *  `parse-liteparse` Cargo feature is not compiled in. */
const UNSUPPORTED_CODE = "unsupported"

let nativeUnsupported = false

/** Test seam — resets the module-level capability cache. */
export function __resetNativePdfCapabilityForTests(): void {
  nativeUnsupported = false
}

function errorMessage(err: unknown): string {
  if (typeof err === "string") return err
  if (err instanceof Error) return err.message
  return String(err)
}

function mapDtoToParseResult(dto: NativeParseDto): PDFParseResult {
  if (!dto || !Array.isArray(dto.pages)) {
    throw new Error("parse_document_native returned a malformed DTO")
  }
  const pages = dto.pages.map((page) => ({
    pageNumber: page.pageNumber,
    text: page.text,
    width: page.width,
    height: page.height,
    items: page.items,
    ...(page.truncated ? { itemsTruncated: true } : {}),
  }))
  return {
    // Join pages with "\n\n" so the pdfjs `result.text` invariant (relied on
    // by `computePdfPageMap` in twin ingest) holds on the native path too.
    text: pages.map((p) => p.text).join("\n\n"),
    pageCount: pages.length,
    pages,
    metadata: {},
  }
}

/**
 * Parse a PDF through the native liteparse backend. Desktop (Tauri) only —
 * throws immediately on web/mobile shells and whenever the native path is
 * unavailable or fails, so the caller's pdfjs fallback kicks in.
 */
export async function parsePdfNative(
  bytes: Uint8Array,
  options: NativePdfOptions = {}
): Promise<PDFParseResult> {
  if (!isTauri()) {
    throw new Error("native PDF parsing requires the Tauri shell")
  }
  if (nativeUnsupported) {
    throw new Error(UNSUPPORTED_CODE)
  }

  let dto: NativeParseDto
  try {
    dto = await documentTransport.call<NativeParseDto>("parse_document_native", {
      payload: {
        // Tauri serializes Uint8Array as a number array transparently.
        bytes,
        password: options.password,
        targetPages: options.targetPages,
      },
    })
  } catch (err) {
    const message = errorMessage(err)
    if (message.startsWith(UNSUPPORTED_CODE)) {
      nativeUnsupported = true
    }
    throw new Error(message)
  }

  return mapDtoToParseResult(dto)
}
