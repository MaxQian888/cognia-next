/**
 * OCR runtime error class.
 *
 * Lives in `lib/ocr/` (not `types/`) because it is runtime code. Its
 * discriminant `OcrErrorCode` is a pure type defined in `@/types/ocr`.
 * Re-exported from `lib/ocr/index.ts` so external consumers keep importing it
 * from `@/lib/ocr`.
 */

import type { OcrErrorCode } from "@/types/ocr"

export class OcrError extends Error {
  readonly code: OcrErrorCode
  readonly providerId: string
  readonly cause?: unknown

  constructor(code: OcrErrorCode, providerId: string, message: string, cause?: unknown) {
    super(message)
    this.name = "OcrError"
    this.code = code
    this.providerId = providerId
    this.cause = cause
  }
}
