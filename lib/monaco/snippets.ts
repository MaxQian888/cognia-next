/**
 * Cognia compat shim — Monaco snippet/Emmet registration. The full
 * registry lives in Cognia; in cognia-next we expose the same API
 * shape but with no-op registration so the canvas hooks compile and
 * still let users add their own snippets via the canvas snippet
 * registry (`@/lib/canvas/snippets/snippet-registry`).
 */

export interface MonacoLikeRegistration {
  dispose(): void
}

export function registerAllSnippets(_monaco: unknown): MonacoLikeRegistration[] {
  return []
}

export function registerEmmetSupport(_monaco: unknown): MonacoLikeRegistration[] {
  return []
}
