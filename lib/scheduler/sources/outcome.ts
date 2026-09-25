/**
 * A source write resolves `void` on success, so a backend that ANSWERS "no"
 * (`false` for "nothing to pause", `null` for "no such task") has to become a
 * throw at the source boundary. Without it every caller, the page's action
 * handlers and the bulk toolbar alike, saw a refused pause as a done pause:
 * they only report failures that reject.
 */
export function requireSourceOutcome(result: unknown, failure: string): void {
  if (result === false || result === null) throw new Error(failure)
}
