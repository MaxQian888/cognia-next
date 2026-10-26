/**
 * Line-preserving redaction for configuration text bound for a model
 * (ADR-0238 §5).
 *
 * Every plugin model call passes the PII gate (`plugin-pii-gate.ts`), which
 * refuses a message that still carries an email, a key or a credential path.
 * An instruction file can hold any of those, so an audit needs the text
 * redacted before it is sent, and its findings need to point at real lines.
 * Redacting line by line keeps line numbers identical; a secret that spans
 * lines (a PEM block) blanks those lines instead. Text that still trips the
 * gate after that is withheld (`null`), so the caller knows not to send it
 * rather than discovering the refusal mid-audit.
 */

import { hasNoLeakingPii, redactText } from "@cognia/redact"

export const REDACTED_LINE = "[REDACTED]"

const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]+-----/
const PEM_END = /-----END [A-Z0-9 ]+-----/

function blankPemBlocks(lines: string[]): string[] {
  const out = [...lines]
  let inside = false
  for (let index = 0; index < out.length; index++) {
    const line = out[index] ?? ""
    if (!inside && PEM_BEGIN.test(line)) inside = true
    if (inside) out[index] = REDACTED_LINE
    if (inside && PEM_END.test(line)) inside = false
  }
  return out
}

/** `text` with secrets and personal data replaced, line count unchanged; `null` when that is not possible. */
export function redactForModel(text: string): string | null {
  const lines = text.split("\n").map((line) => redactText(line).redacted)
  const joined = lines.join("\n")
  if (hasNoLeakingPii(joined)) return joined
  const blanked = blankPemBlocks(lines).join("\n")
  return hasNoLeakingPii(blanked) ? blanked : null
}
