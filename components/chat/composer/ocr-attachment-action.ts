/**
 * Pure decision logic for the composer attachment OCR menu.
 *
 * Kept out of `composer.tsx` so it can be unit-tested without mounting the
 * whole composer + PromptInput provider. The browser-coupled bits (finding the
 * attachment, fetching its blob URL) stay in the component; this function owns
 * the "run OCR, then append-to-input or show-the-sheet" behaviour.
 */

import type { OcrInput, OcrResult } from "@/types/ocr"

export type OcrAttachmentAction = "extract-to-input" | "view-result"

export interface ApplyComposerOcrOptions {
  action: OcrAttachmentAction
  blob: Blob
  mimeType: string
  /** `useOcr().run` — returns null on error / abort. */
  run: (input: OcrInput) => Promise<OcrResult | null>
  /** Current textarea draft. */
  getInput: () => string
  /** Replace the textarea draft. */
  setInput: (value: string) => void
  /** Open the per-page result sheet. */
  showResult: (result: OcrResult) => void
}

/**
 * Append OCR'd plain text to the draft (extract-to-input) or surface the
 * per-page sheet (view-result). No-op when extraction fails.
 */
export async function applyComposerOcr(opts: ApplyComposerOcrOptions): Promise<void> {
  const result = await opts.run({
    source: { kind: "blob", blob: opts.blob, mimeType: opts.mimeType },
  })
  if (!result) return
  if (opts.action === "extract-to-input") {
    const current = opts.getInput()
    const separator = current && !current.endsWith("\n") ? "\n\n" : ""
    opts.setInput(`${current}${separator}${result.combinedText}`)
  } else {
    opts.showResult(result)
  }
}
