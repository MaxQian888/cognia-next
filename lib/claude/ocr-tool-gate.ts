/**
 * Pure gate for the OCR agent tool (`cognia-ocr` / `ocr.extract`, ADR-0024).
 *
 * Extracted from `build-options.ts` so the verdict is unit-testable without the
 * full send-options pipeline (mirrors the `applyComputerUseTools` split).
 *
 * OCR is low-risk, so unlike Computer Use it defaults to **allowed** in every
 * surface, including IM-bound conversations. It is suppressed only on an
 * explicit opt-out:
 *   - `character.enableOcr === false` (kill switch for a character), or
 *   - for an IM session, the per-conversation `allowOcr === false`.
 */

import type { Character } from "./types"

export interface OcrToolGateInput {
  character?: Pick<Character, "enableOcr"> | null
  /** True when the session is bound to an IM platform adapter. */
  imSession?: boolean
  /** `ConversationOverrideRow.allowOcr` for the IM conversation, if any. */
  allowOcrOverride?: boolean
}

/** True when the `ocr.extract` tool should be surfaced to the model. */
export function isOcrToolAllowed(input: OcrToolGateInput): boolean {
  if (input.character?.enableOcr === false) return false
  if (input.imSession && input.allowOcrOverride === false) return false
  return true
}
