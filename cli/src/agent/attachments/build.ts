/**
 * Attachment orchestrator: the CLI's `buildContent`. Extracts every `@<path>`
 * file reference, classifies it, and routes each to the right handler — images
 * and native-PDF become content blocks; text/rich-doc/OCR text folds into the
 * prompt string. Returns a plain string when no media blocks are produced so
 * non-media turns keep the exact original wire shape. Async because rich-doc
 * extraction and OCR are async. Every handler is injected for unit testing.
 */
import type { SendContent, SendContentBlock } from "@/lib/claude/types"
import { encodeImageBlock as realEncodeImageBlock } from "../image-input"
import { classifyRef, extractFileRefs } from "./classify"
import { extractRichDocBlock as realExtractRich, type RichDocResult } from "./documents"
import { resolveImageRef as realResolveImage, type ImageResolution } from "./image"
import { resolvePdfRef as realResolvePdf, type PdfResolution } from "./pdf"
import { readTextFileBlock as realReadText, type TextFileResult } from "./text-files"

type ImageBlock = Extract<SendContentBlock, { type: "image" }>
type DocumentBlock = Extract<SendContentBlock, { type: "document" }>

export interface BuildAttachmentDeps {
  provider: string
  model: string
  isAnthropic: boolean
  anthropicKey: () => string | null
  encodeImageBlock?: (ref: string, cwd: string) => ImageBlock | null
  readTextFileBlock?: (ref: string, cwd: string) => TextFileResult
  extractRichDocBlock?: (ref: string, cwd: string) => Promise<RichDocResult>
  resolveImageRef?: (ref: string, cwd: string) => Promise<ImageResolution>
  resolvePdfRef?: (ref: string, cwd: string) => Promise<PdfResolution>
}

export interface BuiltAttachmentContent {
  content: SendContent
  imageCount: number
  documentCount: number
  injectedFiles: string[]
  ocr: string[]
  failed: string[]
  skipped: string[]
}

export async function buildAttachmentContent(
  prompt: string,
  cwd: string,
  deps: BuildAttachmentDeps
): Promise<BuiltAttachmentContent> {
  const encodeImageBlock = deps.encodeImageBlock ?? ((r, c) => realEncodeImageBlock(r, c))
  const readTextFileBlock = deps.readTextFileBlock ?? ((r, c) => realReadText(r, c))
  const extractRichDocBlock = deps.extractRichDocBlock ?? ((r, c) => realExtractRich(r, c))
  // The image resolver forwards the (possibly injected) encoder so the native
  // block path stays testable, and OCRs through to text on a non-vision model.
  const resolveImageRef =
    deps.resolveImageRef ??
    ((r, c) =>
      realResolveImage(r, c, {
        isAnthropic: deps.isAnthropic,
        provider: deps.provider,
        model: deps.model,
        anthropicKey: deps.anthropicKey,
        encodeImageBlock,
      }))
  const resolvePdfRef =
    deps.resolvePdfRef ??
    ((r, c) =>
      realResolvePdf(r, c, {
        isAnthropic: deps.isAnthropic,
        provider: deps.provider,
        model: deps.model,
        anthropicKey: deps.anthropicKey,
      }))

  const refs = extractFileRefs(prompt)
  const imageBlocks: ImageBlock[] = []
  const documentBlocks: DocumentBlock[] = []
  const injectedTexts: string[] = []
  const injectedFiles: string[] = []
  const ocr: string[] = []
  const failed: string[] = []
  const skipped: string[] = []

  for (const ref of refs) {
    const kind = classifyRef(ref)
    if (kind === "image") {
      const r = await resolveImageRef(ref, cwd)
      if (r.kind === "block") imageBlocks.push(r.block)
      else if (r.kind === "text") {
        // Non-vision model: the image was OCR'd to text and folds into the prompt.
        injectedTexts.push(r.text)
        injectedFiles.push(ref)
        ocr.push(ref)
      } else failed.push(ref)
    } else if (kind === "text") {
      const r = readTextFileBlock(ref, cwd)
      if (r.ok) {
        injectedTexts.push(r.text)
        injectedFiles.push(ref)
      } else failed.push(ref)
    } else if (kind === "rich") {
      const r = await extractRichDocBlock(ref, cwd)
      if (r.ok) {
        injectedTexts.push(r.text)
        injectedFiles.push(ref)
      } else failed.push(ref)
    } else if (kind === "pdf") {
      const r = await resolvePdfRef(ref, cwd)
      if (r.kind === "block") documentBlocks.push(r.block)
      else if (r.kind === "text") {
        injectedTexts.push(r.text)
        injectedFiles.push(ref)
        ocr.push(ref)
      } else failed.push(ref)
    } else {
      skipped.push(ref)
    }
  }

  const notes = failed.length > 0 ? `\n\n[could not read: ${failed.join(", ")}]` : ""
  const leadingText = [prompt, ...injectedTexts].join("\n\n") + notes

  // Plain string unless we produced image/document blocks.
  if (imageBlocks.length === 0 && documentBlocks.length === 0) {
    return {
      content: injectedTexts.length > 0 || notes ? leadingText : prompt,
      imageCount: 0,
      documentCount: 0,
      injectedFiles,
      ocr,
      failed,
      skipped,
    }
  }

  const blocks: SendContentBlock[] = [
    { type: "text", text: leadingText },
    ...documentBlocks,
    ...imageBlocks,
  ]
  return {
    content: blocks,
    imageCount: imageBlocks.length,
    documentCount: documentBlocks.length,
    injectedFiles,
    ocr,
    failed,
    skipped,
  }
}
