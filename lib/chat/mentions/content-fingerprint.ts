/**
 * A short, stable digest of a record's content, for fingerprints.
 *
 * FNV-1a over the UTF-16 code units, plus the length. The previous fingerprints
 * were the length alone, which misses exactly the edit a person makes most —
 * fixing a word. Not cryptographic, and it does not need to be: the only
 * question asked of it is "is this still the same text".
 */
export function contentFingerprint(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${text.length.toString(36)}.${(hash >>> 0).toString(36)}`
}
