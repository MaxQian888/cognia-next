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

import { processDocument, processDocumentAsync } from "@/lib/document/document-processor"
import type { TwinChunkMetadata, TwinSourceFormat, TwinSourceKind } from "@/types/twin"
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
}

function bufferByteLength(input: ArrayBuffer | Uint8Array): number {
  return input instanceof Uint8Array ? input.byteLength : input.byteLength
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
      return {
        id: processed.id,
        kind: dispatch.kind,
        format: raw.format,
        title: processed.metadata.title || filename,
        originalText: processed.content,
        embeddableText: processed.embeddableContent || processed.content,
        baseMetadata,
        bytes: bufferByteLength(raw.binary),
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

  // Importer family — Phase 4 ships parsers for the document family only;
  // chat / email / code-repo importers land in Phase 4.5 / v1.5. The fallback
  // below keeps the pipeline functional: it treats the input as preformatted
  // plain text so a hand-pasted Slack export still produces chunks.
  const text = raw.text ?? (raw.binary ? bytesToString(raw.binary) : "")
  if (!text) {
    throw new Error(
      `parseSource: importer "${dispatch.importerKey}" not yet wired in cognia-next; ` +
        `pass pre-extracted text via raw.text to fall back to plain-text ingest.`
    )
  }
  return {
    id: raw.id,
    kind: dispatch.kind,
    format: raw.format,
    title: raw.filename,
    originalText: text,
    embeddableText: text,
    baseMetadata: raw.baseMetadata ?? {},
    bytes: text.length,
  }
}
