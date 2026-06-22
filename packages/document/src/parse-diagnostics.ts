/**
 * Parse Diagnostics - Helpers for mapping parser warnings/errors to structured diagnostics
 */

import type { ParseDiagnostic, WordMessage } from "./types"

/**
 * Map mammoth-style WordMessage[] to ParseDiagnostic[]
 */
export function mapWordMessages(messages: WordMessage[]): ParseDiagnostic[] {
  return messages.map((msg) => ({
    code: msg.type === "error" ? ("parse_failed" as const) : ("parser_warning" as const),
    severity: msg.type === "error" ? ("error" as const) : ("warning" as const),
    message: msg.message,
  }))
}

/**
 * Create a blocking diagnostic for catch blocks
 */
export function createBlockingDiagnostic(label: string, error: unknown): ParseDiagnostic {
  const message = error instanceof Error ? error.message : String(error)
  return {
    code: "parse_failed",
    severity: "error",
    message: `Failed to parse ${label}: ${message}`,
  }
}

/**
 * Attach a diagnostic property to an Error via Object.assign
 */
export function attachDiagnosticToError(error: Error, diagnostic: ParseDiagnostic): Error {
  return Object.assign(error, { diagnostic })
}
