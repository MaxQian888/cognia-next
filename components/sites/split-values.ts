/**
 * Split a comma/newline-separated textarea value (email/domain/host lists in the
 * site publish + advanced panels) into trimmed, non-empty items. Returns `[]`
 * for a blank value — callers rely on the array (not `undefined`) contract.
 */
export function splitValues(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
}
