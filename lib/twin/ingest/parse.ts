/**
 * Parse stage of the twin ingest pipeline.
 *
 * Routes a `RawSource` to the right backend (`lib/document/document-processor`
 * for text/binary docs, importers under `lib/twin/importers/` for everything
 * else) and returns a `ParsedSource` shape consumed by the downstream
 * redact / chunk / embed / persist stages.
 *
 * The contract is intentionally narrow: callers pass already-loaded raw
 * text (`text` field) or a binary buffer + filename. The pipeline does not
 * touch the filesystem here — Phase 7's source-uploader UI is responsible
 * for choosing files and passing their contents in.
 */

import { processDocument, processDocumentAsync } from "@cognia/document/document-processor"
import type { PDFParseResult } from "@/types/document"
import type {
  TwinBoundingBox,
  TwinChunkMetadata,
  TwinPageMapEntry,
  TwinSourceFormat,
  TwinSourceKind,
} from "@/types/twin"
import { dispatchSource } from "./dispatch"

export interface RawSource {
  /** Stable identifier for this source — used as the document id. */
  id: string
  /** Filename or display title; controls extension-based detection. */
  filename: string
  /** User-confirmed format (overrides extension detection). */
  format: TwinSourceFormat
  /** Provided when the source is text-based. */
  text?: string
  /** Provided when the source is a binary blob (PDF / DOCX / etc.). */
  binary?: ArrayBuffer | Uint8Array
  /** Optional MIME for binary sources — passed to the document processor. */
  mimeType?: string
  /** Per-format hints merged onto every chunk. */
  baseMetadata?: TwinChunkMetadata
}

export interface ParsedSource {
  /** Echoes the input id for downstream tracing. */
  id: string
  kind: TwinSourceKind
  format: TwinSourceFormat
  /** Display title — preferred over the raw filename when available. */
  title: string
  /** Full original text, byte-for-byte (PII still present). */
  originalText: string
  /** Best-effort embeddable subset (drops markdown frontmatter / nav HTML / …). */
  embeddableText: string
  /** Format-aware metadata to seed `twinChunks.metadata`. */
  baseMetadata: TwinChunkMetadata
  /** Original artefact size (for `twinSources.bytes`). */
  bytes: number
  /**
   * PDF only, native (liteparse) parses only — per-page char ranges within
   * `embeddableText` + per-page bbox unions. The job runner translates the
   * offsets into redacted space and threads them into the chunk stage so
   * chunks carry `pageNumber` / `bboxUnion` provenance. Absent whenever the
   * pdfjs path parsed the document (no spatial items).
   */
  pageMap?: TwinPageMapEntry[]
}

function bufferByteLength(input: ArrayBuffer | Uint8Array): number {
  return input instanceof Uint8Array ? input.byteLength : input.byteLength
}

function isPdfParseResult(value: unknown): value is PDFParseResult {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as PDFParseResult).pages) &&
    typeof (value as PDFParseResult).text === "string"
  )
}

function unionBoxes(items: PDFParseResult["pages"][number]["items"]): TwinBoundingBox | undefined {
  if (!items?.length) return undefined
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const item of items) {
    minX = Math.min(minX, item.x)
    minY = Math.min(minY, item.y)
    maxX = Math.max(maxX, item.x + item.width)
    maxY = Math.max(maxY, item.y + item.height)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/**
 * Locate each PDF page's char range within `embeddableText` (the text that
 * gets redacted + chunked downstream) and union its native text-item boxes.
 *
 * Pure. Returns `undefined` — never throws — whenever the spatial mapping
 * cannot be established: non-PDF formats, pdfjs parses (no `items`), or an
 * embeddable text the joined page text can't be located in. `parsePDF`
 * joins pages with "\n\n" on both the native and pdfjs paths, and
 * `extractPDFEmbeddableContent` embeds `result.text` verbatim, so the
 * `indexOf` base holds for unmodified pipelines.
 */
export function computePdfPageMap(
  format: TwinSourceFormat,
  parseResult: unknown,
  embeddableText: string
): TwinPageMapEntry[] | undefined {
  if (format !== "pdf" || !isPdfParseResult(parseResult)) return undefined
  const { pages, text } = parseResult
  if (!text || pages.length === 0 || !pages.some((p) => p.items?.length)) return undefined

  const base = embeddableText.indexOf(text)
  if (base < 0) return undefined

  const entries: TwinPageMapEntry[] = []
  let cursor = base
  for (const page of pages) {
    const charStart = cursor
    const charEnd = charStart + page.text.length
    const bboxUnion = unionBoxes(page.items)
    entries.push({
      pageNumber: page.pageNumber,
      charStart,
      charEnd,
      ...(bboxUnion ? { bboxUnion } : {}),
    })
    cursor = charEnd + 2 // pages are joined with "\n\n"
  }
  return entries
}

function bytesToString(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  // Best-effort UTF-8 decoding; binary parsers will be invoked first via
  // `processDocumentAsync`, so this branch is only used for text fallbacks.
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes)
}

/**
 * Dispatch + parse. Pure: throws on unknown formats. Importer integrations
 * (slack / lark / mbox / eml / git) are loaded lazily so unused families
 * don't pull their parsers into the bundle.
 */
export async function parseSource(raw: RawSource): Promise<ParsedSource> {
  const dispatch = dispatchSource(raw.format)

  if (dispatch.routesToDocumentProcessor) {
    const filename = raw.filename
    const baseMetadata = raw.baseMetadata ?? {}

    if (raw.binary) {
      const arrayBuffer =
        raw.binary instanceof Uint8Array
          ? (raw.binary.buffer as ArrayBuffer).slice(
              raw.binary.byteOffset,
              raw.binary.byteOffset + raw.binary.byteLength
            )
          : raw.binary
      const processed = await processDocumentAsync(raw.id, filename, arrayBuffer, {
        extractEmbeddable: true,
      })
      const embeddableText = processed.embeddableContent || processed.content
      const pageMap = computePdfPageMap(raw.format, processed.parseResult, embeddableText)
      return {
        id: processed.id,
        kind: dispatch.kind,
        format: raw.format,
        title: processed.metadata.title || filename,
        originalText: processed.content,
        embeddableText,
        baseMetadata,
        bytes: bufferByteLength(raw.binary),
        ...(pageMap ? { pageMap } : {}),
      }
    }

    if (typeof raw.text !== "string") {
      throw new Error(`parseSource: text-based format ${raw.format} requires .text`)
    }

    const processed = processDocument(raw.id, filename, raw.text, {
      extractEmbeddable: true,
    })
    return {
      id: processed.id,
      kind: dispatch.kind,
      format: raw.format,
      title: processed.metadata.title || filename,
      originalText: processed.content,
      embeddableText: processed.embeddableContent || processed.content,
      baseMetadata,
      bytes: raw.text.length,
    }
  }

  // Importer family — chat / email / code-repo. Each importer returns
  // `RawSource[]` because some bundles fan out (one ChatGPT export ≠ N
  // conversations). When parseSource encounters a TwinSource row already
  // stamped with an importer-family format (typical paste-mode path) we
  // run the importer in-place and concatenate the fan-out into a single
  // `ParsedSource` so downstream chunk/embed see one document.
  const text = raw.text ?? (raw.binary ? bytesToString(raw.binary) : "")
  if (!text) {
    throw new Error(
      `parseSource: importer "${dispatch.importerKey}" requires raw.text for in-pipeline parse`
    )
  }

  const importerOpts = { twinId: raw.id, source: raw.filename }
  let produced: { title: string; markdown: string; speakers?: string[] } | null = null

  try {
    if (raw.format === "chatgpt-export") {
      const mod = await import("@/lib/twin/importers/chat-export/chatgpt")
      produced = collectImporterText(mod.parseChatgptExport(text, importerOpts), raw.filename)
    } else if (raw.format === "claude-export") {
      const mod = await import("@/lib/twin/importers/chat-export/claude")
      produced = collectImporterText(mod.parseClaudeExport(text, importerOpts), raw.filename)
    } else if (raw.format === "gemini-export") {
      const mod = await import("@/lib/twin/importers/chat-export/gemini")
      produced = collectImporterText(mod.parseGeminiExport(text, importerOpts), raw.filename)
    } else if (raw.format === "slack-export") {
      const mod = await import("@/lib/twin/importers/chat-export/slack")
      produced = collectImporterText(mod.parseSlackExport(text, importerOpts), raw.filename)
    } else if (raw.format === "lark-export") {
      const mod = await import("@/lib/twin/importers/chat-export/lark")
      produced = collectImporterText(mod.parseLarkExport(text, importerOpts), raw.filename)
    } else if (raw.format === "dingtalk-export") {
      const mod = await import("@/lib/twin/importers/chat-export/dingtalk")
      produced = collectImporterText(mod.parseDingtalkExport(text, importerOpts), raw.filename)
    } else if (raw.format === "wechat-export") {
      const mod = await import("@/lib/twin/importers/chat-export/wechat")
      produced = collectImporterText(mod.parseWechatExport(text, importerOpts), raw.filename)
    } else if (raw.format === "mbox") {
      const mod = await import("@/lib/twin/importers/email/mbox")
      produced = collectImporterText(mod.parseMbox(text, importerOpts), raw.filename)
    } else if (raw.format === "eml") {
      const mod = await import("@/lib/twin/importers/email/eml")
      produced = collectImporterText(mod.parseEml(text, importerOpts), raw.filename)
    } else if (raw.format === "git-repo") {
      // git-repo runs at uploader time (needs filesystem). If we still
      // see a row with this format at parse time, treat the raw text as
      // already-rendered commit markdown (the uploader produces this
      // shape via `parseGitRepo`).
      produced = { title: raw.filename, markdown: text }
    }
  } catch (err) {
    // Importer threw (eg. malformed JSON) — surface the error so the job
    // runner marks the source as failed with a clear message.
    throw new Error(
      `parseSource: importer "${dispatch.importerKey}" failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }

  if (!produced || !produced.markdown.trim()) {
    // Importer produced nothing usable — fall back to the raw text so the
    // chunker still has something to embed (better than throwing).
    produced = { title: raw.filename, markdown: text }
  }

  // Union importer-discovered speakers with any the raw source already
  // carried — the redaction pass (`deriveNameHints`) reads them off the
  // parsed result, so dropping them here would leak participant names to
  // the cloud embedder on the paste-mode importer path.
  const speakers = [
    ...new Set([...(raw.baseMetadata?.speakers ?? []), ...(produced.speakers ?? [])]),
  ]
  return {
    id: raw.id,
    kind: dispatch.kind,
    format: raw.format,
    title: produced.title,
    originalText: produced.markdown,
    embeddableText: produced.markdown,
    baseMetadata: {
      ...(raw.baseMetadata ?? {}),
      ...(speakers.length > 0 ? { speakers } : {}),
    },
    bytes: produced.markdown.length,
  }
}

/**
 * Reduce an importer's `RawSource[]` fan-out down to a single combined
 * markdown blob. Uses the first source's filename as the document title
 * and concatenates the remaining bodies with a horizontal-rule separator
 * so the heading-aware chunker can still slice on `###` headers. The
 * fan-out's per-source speakers are unioned so the caller can merge them
 * into the parsed `baseMetadata`.
 */
function collectImporterText(
  produced: RawSource[] | undefined,
  fallbackTitle: string
): { title: string; markdown: string; speakers?: string[] } {
  if (!produced || produced.length === 0) {
    return { title: fallbackTitle, markdown: "" }
  }
  const first = produced[0]
  const title = first.filename.replace(/\.md$/i, "") || fallbackTitle
  const parts = produced.map((src) => src.text ?? "").filter((s) => s.trim().length > 0)
  const speakers = [...new Set(produced.flatMap((src) => src.baseMetadata?.speakers ?? []))]
  return {
    title,
    markdown: parts.join("\n\n---\n\n"),
    ...(speakers.length > 0 ? { speakers } : {}),
  }
}
