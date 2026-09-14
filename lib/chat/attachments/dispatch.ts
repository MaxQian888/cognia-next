/**
 * Attachment → {@link SendContentBlock} dispatch for the chat composer.
 *
 * This is the single place that turns a staged composer attachment into the
 * content block(s) we hand to the model. It deliberately reuses the existing,
 * production-wired subsystems rather than reimplementing any of them:
 *
 *   - image classification + downscale + base64 → `lib/ocr/image-prep`
 *   - PDF / docx / xlsx / pptx / csv / epub / md / code / html text extraction
 *     → `lib/document` (`processDocumentAsync`, browser-safe lazy parsers)
 *   - data-URL byte sizing → `lib/chat/draft-attachments`
 *
 * Extraction runs ONCE per file: the composer kicks it off in the background as
 * soon as a file is staged (so the chip can show a token count and a preview
 * before send) and hands the result back via `DispatchOptions.precomputed`.
 *
 * Routing:
 *   - images  → `image` block (downscaled when the long edge is large)
 *   - documents (any non-`unknown` {@link detectDocumentType}) → extracted text
 *     wrapped in a `text` block (kept as `type:'text'` so the connector PII
 *     gate `isPiiSafeSendContent` can scan it)
 *   - videos / animated GIFs → whatever the motion pipeline
 *     (`lib/chat/attachments/video/`) prepared at staging time: a description
 *     plus a storyboard or frames, or the original file where the route allows.
 *     There is no inline path — sampling needs the staged `File`, so a video
 *     that reaches dispatch unprepared is rejected, never guessed at
 *   - everything else → rejected with a machine-readable reason
 *
 * Emitting `text` (not base64 `document`) blocks for documents is intentional:
 * it supports far more formats than Anthropic's PDF-only `document` block, is
 * visible to the PII scanner, and matches how Twin ingest and the CLI already
 * handle attached files.
 */

import { decodeDataUrl, downscaleImage, bytesToBase64, isImageMimeType } from "@/lib/ocr/image-prep"
// Import the specific submodules (not the `@cognia/document` barrel) so the heavy
// pdfjs/mammoth/xlsx parsers stay lazily loaded — the same pattern the Twin
// uploader uses. `processDocumentAsync` dynamic-imports those internally.
import { detectDocumentType, processDocumentAsync } from "@cognia/document/document-processor"
import { isBinaryDocumentType } from "@cognia/document/support-matrix"
import { detectLanguage } from "@cognia/document/parsers/code-parser"
import { hasNoLeakingPii, redactText } from "@cognia/redact"
import type { DocumentType } from "@/types/document"
import type { SendContent, SendContentBlock } from "@cognia/agent-config-types"
import { COMPOSER_IMAGE_MAX_LONG_EDGE } from "./prepare"
import { estimateFallbackTokens } from "@/lib/ai/tokens/fallback-estimator"
import { getCustomImporterOwnersForFile } from "@/lib/plugin/api/import-api"
import { authorizePluginAttachment } from "@/lib/plugin/api/files-api"
import { videoMediaTypeOf } from "./video/classify"
import type { VideoAttachmentInfo } from "./video/attachment-info"
import type { VideoPreprocessResult } from "./video/preprocess"

/**
 * The longest edge (px) we downscale large images to before base64-encoding.
 * Anthropic resamples anything beyond ~1568px on the long edge anyway, so this
 * trims upload + token cost with no quality loss the model would notice.
 */
export const IMAGE_MAX_LONG_EDGE = COMPOSER_IMAGE_MAX_LONG_EDGE

/**
 * Soft ceiling (in estimated tokens) for inlined document text. Above this the
 * composer asks the user to confirm before sending — we never silently truncate.
 * ~12k tokens ≈ a 50 KB text file.
 */
export const INLINE_TOKEN_CEILING = 12_000

/** A composer attachment staged for send. `url` is expected to be a data: URL. */
export interface SubmittedFile {
  url?: string
  mediaType?: string
  filename?: string
  /**
   * Stable staging id. Only used to look this file up in
   * {@link DispatchOptions.precomputed} — absent for callers that extract inline.
   */
  id?: string
}

export type RejectReason =
  | "not-data-url"
  | "unsupported-type"
  | "empty"
  | "parse-failed"
  /** No engine on this device could decode the video. */
  | "video-undecodable"
  /** The video source, or the frames sampled from it, is over its ceiling. */
  | "video-too-large"
  /** A video reached dispatch without having been preprocessed at staging time. */
  | "video-unprocessed"

export interface AttachmentReject {
  filename: string
  reason: RejectReason
}

/**
 * The result of turning ONE staged attachment into its outbound form.
 *
 * The composer computes these in the background the moment a file is staged and
 * hands them back through {@link DispatchOptions.precomputed}, so the send path
 * never re-parses a document the user has already been shown a preview of. It
 * doubles as the data source for the attachment preview panel's "model view":
 * `text` is verbatim what the model receives.
 */
/** One way of sending a video: the blocks, in order, and what they amount to. */
export interface VideoPayload {
  /** Description text block first, then image blocks (sampled) or one `document` block (native). */
  blocks: SendContentBlock[]
  info: VideoAttachmentInfo
  /** Estimated inline cost of the description text. Image cost is not counted, as for images. */
  tokens: number
}

export interface ExtractedVideo {
  /** Storyboard or frames. Always present: it is also the fallback for native. */
  sampled: VideoPayload
  /** The original (or trimmed) file. Present only when native delivery was asked for and prepared. */
  native: VideoPayload | null
  /** The first sampled frame, ≤512 px: the chip thumbnail and a native video's transcript poster. */
  poster: { mediaType: string; base64: string; width: number; height: number }
}

export interface ExtractedAttachment {
  kind: "image" | "document" | "video"
  /**
   * The block to send, or null when the attachment was rejected. For a video it
   * is the first block of the sampled payload — the full set lives in `video`.
   */
  block: SendContentBlock | null
  /** Estimated inline token cost, including opted-in OCR text for images. */
  tokens: number
  /** Set iff `block` is null. */
  rejectReason?: RejectReason
  /** Post-redaction extracted text — exactly what the model receives. */
  text?: string
  /** Post-redaction OCR text sent as a second block beside an image. */
  ocr?: { text: string; tokens: number }
  /** Downscaled image payload description (geometry is read off the rendered <img>). */
  image?: { mediaType: string; bytes: number }
  /** Prepared payloads for a video or animated GIF. */
  video?: ExtractedVideo
}

/**
 * Provenance for one produced block, so the transcript can render "📎 report.pdf"
 * instead of dumping the file's whole extracted text into the user's own bubble.
 *
 * Emitted as an array PARALLEL to {@link DispatchResult.blocks} — entry `i`
 * describes `blocks[i]`. Built in the same loop that produces the blocks, so a
 * rejected file cannot shift the alignment.
 */
export interface AttachmentManifestEntry {
  filename: string
  mediaType: string
  kind: "image" | "document" | "video"
  /** Opaque byte handles keyed by the enabled importer plugin that owns them. */
  pluginHandles?: Record<string, string>
  /**
   * Set on every entry a video produced (one object shared by all of them).
   * `poster` and `fallback` exist only for a native payload: the transcript
   * shows the poster in place of the unstored file, and the controller swaps
   * in `fallback` if the resolved route turns out unable to take video.
   */
  video?: {
    info: VideoAttachmentInfo
    poster?: ExtractedVideo["poster"]
    fallback?: VideoPayload
  }
}

export interface DispatchResult {
  /** Attachment blocks, in the caller's input order. */
  blocks: SendContentBlock[]
  /** Files that could not be turned into a block, with the reason. */
  rejected: AttachmentReject[]
  /** Estimated inline token cost of document text and opted-in image OCR blocks. */
  tokens: number
  /** Parallel to {@link blocks}: where each block came from. */
  manifest: AttachmentManifestEntry[]
}

export interface DispatchOptions {
  /**
   * Send a video's native payload where one was prepared. The composer sets it
   * from the delivery gate's verdict for the conversation's route; left unset,
   * every video goes as its sampled payload. The controller re-checks the
   * resolved route before dispatch either way (`video/route-guard.ts`).
   */
  allowNativeVideo?: boolean
  /** Override the image downscale long-edge (px). Defaults to {@link IMAGE_MAX_LONG_EDGE}. */
  imageMaxLongEdge?: number
  /**
   * OCR fallback for scanned / image-only PDFs whose text layer is empty or
   * sparse. Receives the raw PDF bytes plus whatever text the normal extraction
   * produced; returns OCR'd text to use instead, or `null` to keep the original
   * (which is then rejected as `"empty"`). Defaults to the client-side
   * `runAttachmentPdfOcr` (lazily imported so the OCR stack never enters the
   * eager chat bundle). Injected by tests to avoid loading real pdfjs/tesseract.
   */
  pdfOcrFallback?: (bytes: Uint8Array, extractedText: string) => Promise<string | null>
  /**
   * Staging-time extraction results, keyed by {@link SubmittedFile.id}. A hit
   * short-circuits the (potentially multi-second) parse for that file. Files
   * without an id, or whose id is absent from the map, extract normally.
   */
  precomputed?: ReadonlyMap<string, ExtractedAttachment>
}

/**
 * Below this many non-whitespace chars a PDF's text layer is treated as scanned
 * → trigger the OCR fallback. Mirrors {@link ATTACHMENT_OCR_MIN_TEXT_CHARS}; kept
 * local so the heavy OCR stack stays lazily imported.
 */
export const PDF_OCR_TRIGGER_CHARS = 32

/** Lazy default: only pulls in the OCR stack when a sparse PDF is actually hit. */
async function defaultPdfOcrFallback(
  bytes: Uint8Array,
  extractedText: string
): Promise<string | null> {
  const { runAttachmentPdfOcr } = await import("./pdf-ocr-fallback")
  return runAttachmentPdfOcr(bytes, extractedText)
}

/** Document types whose extracted text reads best inside a fenced code block. */
const FENCED_TYPES: ReadonlySet<DocumentType> = new Set(["code", "json", "markdown", "html", "csv"])

function fenceLanguage(type: DocumentType, filename: string): string {
  if (type === "code") return detectLanguage(filename)
  if (type === "json") return "json"
  if (type === "markdown") return "markdown"
  if (type === "html") return "html"
  return ""
}

/**
 * Wrap a document's extracted text in a `text` block with a filename header so
 * the model knows the provenance of the content. Code-ish types get a fence.
 */
export function formatDocumentText(type: DocumentType, filename: string, content: string): string {
  const header = `Attached file "${filename}":`
  if (FENCED_TYPES.has(type)) {
    const lang = fenceLanguage(type, filename)
    return `${header}\n\n\`\`\`${lang}\n${content}\n\`\`\``
  }
  return `${header}\n\n${content}`
}

function redactOutboundText(text: string): string | null {
  const safeText = hasNoLeakingPii(text) ? text : redactText(text).redacted
  return hasNoLeakingPii(safeText) ? safeText : null
}

/**
 * Add explicitly opted-in OCR text to a staged image result.
 *
 * Raw OCR remains local to the preview store. This boundary adds provenance,
 * runs the same fail-closed PII gate as extracted documents, and records the
 * exact extra token cost before the result enters `DispatchOptions.precomputed`.
 */
export function withImageOcrText(
  result: ExtractedAttachment,
  filename: string,
  ocrText: string
): ExtractedAttachment {
  const trimmed = ocrText.trim()
  if (result.kind !== "image" || !result.block || !trimmed) return result

  const safeText = redactOutboundText(`OCR text from attached image "${filename}":\n\n${trimmed}`)
  if (!safeText) return result
  const ocrTokens = estimateFallbackTokens(safeText)
  return {
    ...result,
    tokens: result.tokens + ocrTokens,
    ocr: { text: safeText, tokens: ocrTokens },
  }
}

async function imageBlock(
  bytes: Uint8Array,
  mediaType: string,
  maxLongEdge: number
): Promise<Extract<SendContentBlock, { type: "image" }>> {
  const scaled = await downscaleImage(bytes, mediaType, maxLongEdge)
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: scaled.mimeType,
      data: bytesToBase64(scaled.bytes),
    },
  }
}

/**
 * Extract, format and redact one document's text. Returns null when the file
 * yields nothing usable (empty text layer, or text that still leaks PII after
 * redaction) — the caller turns that into an `"empty"` rejection.
 */
async function extractDocumentText(
  type: DocumentType,
  filename: string,
  bytes: Uint8Array,
  id: string,
  pdfOcrFallback: (bytes: Uint8Array, extractedText: string) => Promise<string | null>
): Promise<string | null> {
  // Binary formats need the raw ArrayBuffer; text formats decode to a string so
  // processDocumentAsync takes its sync fast-path.
  const data: string | ArrayBuffer = isBinaryDocumentType(type)
    ? toArrayBuffer(bytes)
    : new TextDecoder().decode(bytes)
  const processed = await processDocumentAsync(id, filename, data, {
    extractEmbeddable: true,
  })
  let text = (processed.embeddableContent || processed.content || "").trim()

  // Scanned / image-only PDFs yield an empty (or page-number-only) text layer.
  // Re-run them through the client-side OCR fallback before giving up.
  if (type === "pdf" && nonWhitespaceLength(text) < PDF_OCR_TRIGGER_CHARS) {
    const ocrText = (await pdfOcrFallback(bytes, text))?.trim()
    if (ocrText) text = ocrText
  }

  if (!text) return null
  const formatted = formatDocumentText(type, filename, text)
  return redactOutboundText(formatted)
}

function nonWhitespaceLength(text: string): number {
  return text.replace(/\s+/g, "").length
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // Copy into a standalone ArrayBuffer so we never hand a SharedArrayBuffer /
  // view-with-offset to the parsers.
  const out = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(out).set(bytes)
  return out
}

function authorizeMatchingPluginAttachments(
  file: SubmittedFile,
  filename: string,
  mediaType: string
): Record<string, string> | undefined {
  const decoded = file.url?.startsWith("data:") ? decodeDataUrl(file.url) : null
  if (!decoded) return undefined
  const effectiveMimeType = mediaType || decoded.mimeType || "application/octet-stream"
  const owners = getCustomImporterOwnersForFile(filename, effectiveMimeType)
  if (owners.length === 0) return undefined
  return Object.fromEntries(
    owners.map((pluginId) => [
      pluginId,
      authorizePluginAttachment(pluginId, {
        name: filename,
        mimeType: effectiveMimeType,
        size: decoded.bytes.byteLength,
        bytes: decoded.bytes,
      }),
    ])
  )
}

function reject(kind: ExtractedAttachment["kind"], reason: RejectReason): ExtractedAttachment {
  return { kind, block: null, tokens: 0, rejectReason: reason }
}

/**
 * Wrap a motion-pipeline result as the staged extraction the composer caches.
 * `groupId` ties every part the video produces to one transcript card.
 */
export function extractedFromVideoResult(
  result: VideoPreprocessResult,
  { filename, groupId }: { filename: string; groupId: string }
): ExtractedAttachment {
  const base: Omit<VideoAttachmentInfo, "delivery" | "frameTimes" | "grid"> = {
    groupId,
    filename,
    sourceMediaType: result.source.mediaType,
    kind: result.source.kind,
    durationSec: result.source.durationSec,
    width: result.source.width,
    height: result.source.height,
    ...(result.source.frameCount !== undefined ? { frameCount: result.source.frameCount } : {}),
    strategy: result.settings.strategy,
    range: result.settings.range,
    engine: result.engine,
  }
  const sampled: VideoPayload = {
    blocks: result.sampled.blocks,
    tokens: estimateFallbackTokens(result.sampled.description),
    info: {
      ...base,
      delivery: result.sampled.delivery,
      frameTimes: result.sampled.frames.map((frame) => frame.timeSec),
      ...(result.sampled.grid ? { grid: result.sampled.grid } : {}),
    },
  }
  const native: VideoPayload | null = result.native
    ? {
        blocks: result.native.blocks,
        tokens: estimateFallbackTokens(result.native.description),
        info: {
          ...base,
          sourceMediaType: result.native.mediaType,
          delivery: "native",
          frameTimes: [],
        },
      }
    : null
  return {
    kind: "video",
    block: sampled.blocks[0] ?? null,
    tokens: sampled.tokens,
    video: { sampled, native, poster: result.poster },
  }
}

/**
 * Re-gate a video payload at the outbound boundary: its description text runs
 * through the same fail-closed PII gate as document text (a filename can carry
 * an address), and only the block shapes the pipeline produces may pass.
 */
function gateVideoPayload(payload: VideoPayload): VideoPayload | null {
  const blocks: SendContentBlock[] = []
  let tokens = 0
  for (const block of payload.blocks) {
    if (block.type === "text") {
      const text = redactOutboundText(block.text)
      if (!text) return null
      tokens += estimateFallbackTokens(text)
      blocks.push({ type: "text", text })
    } else if (block.type === "image") {
      blocks.push(block)
    } else if (block.type === "document" && block.source.media_type.startsWith("video/")) {
      blocks.push(block)
    } else {
      return null
    }
  }
  return blocks.length > 0 ? { ...payload, blocks, tokens } : null
}

/**
 * Treat a staging cache as an optimization, never as a privacy authority.
 * `DispatchOptions.precomputed` is public and can be supplied by callers other
 * than the composer store, so every cached text payload is re-gated at the
 * final outbound boundary.
 */
function gateCachedAttachment(result: ExtractedAttachment): ExtractedAttachment {
  if (!result.block) return result
  if (result.kind === "video") {
    if (!result.video) return reject("video", "video-unprocessed")
    const sampled = gateVideoPayload(result.video.sampled)
    if (!sampled) return reject("video", "empty")
    const native = result.video.native ? gateVideoPayload(result.video.native) : null
    return {
      ...result,
      block: sampled.blocks[0]!,
      tokens: sampled.tokens,
      video: { ...result.video, sampled, native },
    }
  }
  if (result.kind === "document") {
    if (result.block.type !== "text") return reject("document", "parse-failed")
    const text = redactOutboundText(result.block.text)
    if (!text) return reject("document", "empty")
    const tokens = estimateFallbackTokens(text)
    return {
      ...result,
      block: { ...result.block, text },
      text,
      tokens,
    }
  }

  if (result.block.type !== "image") return reject("image", "parse-failed")
  if (!result.ocr) return result
  const ocrText = redactOutboundText(result.ocr.text)
  if (!ocrText) return reject("image", "empty")
  const ocrTokens = estimateFallbackTokens(ocrText)
  return {
    ...result,
    ocr: { text: ocrText, tokens: ocrTokens },
    tokens: ocrTokens,
  }
}

/**
 * Turn ONE staged attachment into its outbound form.
 *
 * Called twice in a file's life but only ever *executed* once: the composer
 * runs it in the background at staging time and feeds the result back through
 * {@link DispatchOptions.precomputed}, so the send path is a map lookup.
 */
export async function extractAttachment(
  file: SubmittedFile,
  options: DispatchOptions = {},
  /** Disambiguates the document id handed to the parser. */
  index = 0
): Promise<ExtractedAttachment> {
  const maxLongEdge = options.imageMaxLongEdge ?? IMAGE_MAX_LONG_EDGE
  const pdfOcrFallback = options.pdfOcrFallback ?? defaultPdfOcrFallback
  const filename = file.filename ?? "attachment"
  const url = file.url ?? ""
  const decoded = url.startsWith("data:") ? decodeDataUrl(url) : null
  const mediaType = file.mediaType || decoded?.mimeType || ""
  const looksLikeImage = mediaType.startsWith("image/") || isImageMimeType(mediaType)

  // Videos are sampled from the staged File, which this function never sees.
  if (!looksLikeImage && videoMediaTypeOf({ name: filename, mediaType })) {
    return reject("video", "video-unprocessed")
  }

  if (!decoded) return reject(looksLikeImage ? "image" : "document", "not-data-url")

  if (looksLikeImage) {
    const block = await imageBlock(decoded.bytes, mediaType, maxLongEdge)
    return {
      kind: "image",
      block,
      tokens: 0,
      image: {
        mediaType: block.source.media_type,
        // base64 inflates by 4/3; report the decoded size the model actually gets.
        bytes: Math.floor((block.source.data.length * 3) / 4),
      },
    }
  }

  const type = detectDocumentType(filename)
  if (type === "unknown") return reject("document", "unsupported-type")

  try {
    const text = await extractDocumentText(
      type,
      filename,
      decoded.bytes,
      `att-${index}`,
      pdfOcrFallback
    )
    if (!text) return reject("document", "empty")
    return {
      kind: "document",
      block: { type: "text", text },
      tokens: estimateFallbackTokens(text),
      text,
    }
  } catch {
    return reject("document", "parse-failed")
  }
}

/**
 * Convert a list of staged attachments into content blocks. Images are
 * downscaled + base64-encoded; documents are text-extracted via `lib/document`.
 * Returns the produced blocks plus the list of files that were rejected.
 *
 * Block order follows the INPUT order: the composer lets the user drag chips
 * around, and "compare the first image with that spreadsheet" only works if the
 * order the user sees is the order the model receives.
 */
export async function buildAttachmentBlocks(
  files: readonly SubmittedFile[],
  options: DispatchOptions = {}
): Promise<DispatchResult> {
  const blocks: SendContentBlock[] = []
  const rejected: AttachmentReject[] = []
  const manifest: AttachmentManifestEntry[] = []
  let tokens = 0

  let index = 0
  for (const f of files) {
    const filename = f.filename ?? "attachment"
    const cached = f.id ? options.precomputed?.get(f.id) : undefined
    const result = cached
      ? gateCachedAttachment(cached)
      : await extractAttachment(f, options, index)
    if (result.kind === "video" && result.block && result.video) {
      const { sampled, native, poster } = result.video
      const payload = options.allowNativeVideo && native ? native : sampled
      const entry: AttachmentManifestEntry = {
        filename,
        mediaType: payload.info.sourceMediaType,
        kind: "video",
        video:
          payload === native
            ? { info: payload.info, poster, fallback: sampled }
            : { info: payload.info },
      }
      for (const block of payload.blocks) {
        blocks.push(block)
        manifest.push(entry)
      }
      tokens += payload.tokens
    } else if (result.block) {
      const mediaType = f.mediaType || result.image?.mediaType || ""
      const pluginHandles =
        result.kind === "document"
          ? authorizeMatchingPluginAttachments(f, filename, mediaType)
          : undefined
      const entry: AttachmentManifestEntry = {
        filename,
        mediaType,
        kind: result.kind,
        ...(pluginHandles ? { pluginHandles } : {}),
      }
      if (result.block.type === "text" && pluginHandles) {
        const handleHint = Object.entries(pluginHandles)
          .map(([pluginId, handle]) => `${pluginId}: ${handle}`)
          .join(", ")
        const text = `${result.block.text}\n\nAuthorized plugin attachment handles: ${handleHint}`
        blocks.push({ ...result.block, text })
        tokens += estimateFallbackTokens(text) - estimateFallbackTokens(result.block.text)
      } else {
        blocks.push(result.block)
      }
      // Pushed in lockstep with `blocks` so index alignment holds even when an
      // earlier file was rejected.
      manifest.push(entry)
      if (result.kind === "image" && result.ocr) {
        blocks.push({ type: "text", text: result.ocr.text })
        manifest.push(entry)
      }
      tokens += result.tokens
    } else {
      rejected.push({ filename, reason: result.rejectReason! })
    }
    index++
  }

  return { blocks, rejected, tokens, manifest }
}

/**
 * Build the final {@link SendContent} for a user turn: attachment blocks first,
 * then the trimmed user text. Falls back to a plain string when there are no
 * attachment blocks (keeps single-text turns wire-compatible with the old path).
 */
export async function buildSendContent(
  text: string,
  files: readonly SubmittedFile[],
  options: DispatchOptions = {}
): Promise<{
  content: SendContent
  rejected: AttachmentReject[]
  tokens: number
  manifest: AttachmentManifestEntry[]
}> {
  const trimmed = text.trim()
  const { blocks, rejected, tokens, manifest } = await buildAttachmentBlocks(files, options)

  if (blocks.length === 0) {
    return { content: trimmed, rejected, tokens, manifest }
  }
  // Attachment blocks stay at indices 0..n-1 so `manifest[i]` keeps describing
  // `content[i]`; the user's own text (and any link context merged in later)
  // is appended after them.
  const out: SendContentBlock[] = [...blocks]
  if (trimmed) out.push({ type: "text", text: trimmed })
  return { content: out, rejected, tokens, manifest }
}

/** Estimate the inline token cost of a document's extracted text. */
export function estimateDocumentTokens(content: string): number {
  return estimateFallbackTokens(content)
}
