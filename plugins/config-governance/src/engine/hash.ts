/**
 * Small, dependency-free FNV-1a hashing for stable identifiers: a finding id
 * that survives re-runs while its evidence holds, and a text fingerprint that
 * tells whether a surface changed since it was audited. Not a security hash.
 */

export function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

/** Two independent 32-bit hashes, for fewer collisions over long texts. */
export function textFingerprint(text: string): string {
  return `${fnv1a(text)}${fnv1a(`${text.length}:${text}`)}`
}
