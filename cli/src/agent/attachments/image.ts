/**
 * Decide how to attach a `@<path>` image reference, mirroring {@link resolvePdfRef}:
 *   - active model accepts image input (Claude, or any models.dev model whose
 *     `modalities.input` includes "image") → native base64 `image` block;
 *   - otherwise → OCR the image to text (Claude vision via the Node-safe runner)
 *     and fold it into the prompt as a `<file>` block, so a text-only model still
 *     gets the image's content instead of a block it would reject.
 *
 * Before this gate the image path encoded a block unconditionally, so attaching
 * an image while a text-only model was active sent a block the provider rejects.
 * Pure: image encode + fs + OCR runner injected for unit testing.
 */
import nodeFs from "node:fs"
import path from "node:path"

import type { SendContentBlock } from "@cognia/agent-config-types"
import { encodeImageBlock as realEncodeImageBlock } from "../image-input"
import { modelSupportsImageInput } from "./model-modalities"
import { ocrExtractText, type OcrRunResult } from "./ocr"

type ImageBlock = Extract<SendContentBlock, { type: "image" }>

/** Extension → OCR `media_type`. Mirrors the vision-accepted formats. */
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

export interface ImageDeps {
  isAnthropic: boolean
  provider: string
  model: string
  /** Resolves the Anthropic API key for the OCR fallback. */
  anthropicKey?: () => string | null
  /** Injectable image-block encoder; defaults to the real `encodeImageBlock`. */
  encodeImageBlock?: (ref: string, cwd: string) => ImageBlock | null
  readFileBytes?: (absPath: string) => ArrayBuffer
  isFile?: (absPath: string) => boolean
  /** Injectable OCR runner; defaults to `ocrExtractText`. */
  runOcr?: (data: ArrayBuffer, mimeType: string) => Promise<OcrRunResult>
}

export type ImageResolution =
  | { kind: "block"; block: ImageBlock }
  | { kind: "text"; text: string }
  | { kind: "failed"; reason?: string }

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

export async function resolveImageRef(
  ref: string,
  cwd: string,
  deps: ImageDeps
): Promise<ImageResolution> {
  // Anthropic is always vision-capable; otherwise gate on the models.dev
  // modalities (same source of truth as the PDF gate).
  const native = deps.isAnthropic || modelSupportsImageInput(deps.provider, deps.model)
  if (native) {
    const encodeImageBlock = deps.encodeImageBlock ?? ((r, c) => realEncodeImageBlock(r, c))
    const block = encodeImageBlock(ref, cwd)
    return block ? { kind: "block", block } : { kind: "failed" }
  }

  // Model can't see images → OCR to text (parallel to the PDF fallback).
  const mediaType = IMAGE_MEDIA_TYPES[path.extname(ref).toLowerCase()]
  if (!mediaType) return { kind: "failed", reason: "unsupported-format" }
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

  const runOcr =
    deps.runOcr ??
    ((d: ArrayBuffer, mime: string) =>
      ocrExtractText(d, mime, { anthropicKey: deps.anthropicKey ?? (() => null) }))
  const ocr = await runOcr(data, mediaType)
  if (ocr.ok) return { kind: "text", text: `<file path="${ref}">\n${ocr.text}\n</file>` }
  return { kind: "failed", reason: ocr.reason }
}
