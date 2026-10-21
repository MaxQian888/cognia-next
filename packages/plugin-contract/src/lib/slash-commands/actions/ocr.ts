/**
 * The plugin contract's share of `lib/slash-commands/actions/ocr.ts`, which re-exports these.
 */
import type { OcrError } from "@/lib/ocr/errors"
import type { OcrResult } from "../../../types/ocr/index"

/** Where the OCR'd image came from — lets the chat card show a thumbnail. */
export interface OcrSourceRef {
  kind: "data-url" | "file-path" | "attachment-id"
  value: string
}

export interface SlashOcrResult {
  /** Markdown to push into the chat as a system message. */
  system: string
  /** When set, the composer prepends this text to its textarea. */
  composerText?: string
  /** Raw result — useful for plugin authors. */
  result?: OcrResult
  /** Where the OCR'd image came from — fed into the chat card thumbnail. */
  sourceRef?: OcrSourceRef
  /** Error code when the command failed. */
  errorCode?: OcrError["code"]
}
