/**
 * Stable digest of a corpus Merkle map (ADR-0008 Phase 3).
 *
 * A full wiki rebuild is expensive enough that the user is shown a cost
 * estimate and has to confirm it. The confirmation is bound to *this* value:
 * if the repo changes on disk between the estimate and the confirm, the hash
 * moves, the token stops matching, and the user is asked again rather than
 * silently billed for a rebuild of a corpus they never saw an estimate for.
 *
 * Deliberately synchronous and dependency-free. It is called from the Dexie
 * v142 `.upgrade()` callback — inside `bulkPut`'s map and alongside
 * `.modify()`, neither of which can await `crypto.subtle` — and importing it
 * from `lib/db/schema.ts` must not create a cycle, so this module imports
 * nothing.
 *
 * NOT a security primitive. It answers "did this set of files change?", never
 * "is this content authentic"; use `crypto.subtle.digest` for the latter.
 * FNV-1a over the sorted `path<sep>sha` pairs: order-independent by
 * construction, and sensitive to a file being added, removed, or re-hashed.
 */

const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193

/**
 * Field separator. A NUL is the one byte that can appear in neither a file
 * path nor a hex digest, so `{"ab": "c"}` and `{"a": "bc"}` cannot serialize
 * to the same stream. Built with `fromCharCode` rather than written inline:
 * a literal NUL in source is invisible in review and does not survive every
 * editor or formatter intact.
 */
const SEP = String.fromCharCode(0)

/**
 * FNV-1a over a UTF-16 code-unit stream, seeded so successive chunks chain.
 * `Math.imul` keeps the multiply in int32 — a plain `*` overflows to a double
 * past 2^53 and silently stops being FNV.
 */
function fnv1a(input: string, seed: number): number {
  let hash = seed
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, FNV_PRIME)
  }
  return hash >>> 0
}

/**
 * Digest a `filePath → sha256` map. Returns a fixed-width lowercase hex string.
 *
 * An empty map hashes to a real value (the basis mixed with a zero count)
 * rather than to `""`, so "no files indexed yet" compares equal to itself.
 */
export function hashFileHashes(fileHashes: Record<string, string>): string {
  const paths = Object.keys(fileHashes).sort()
  let hash = FNV_OFFSET_BASIS
  for (const path of paths) {
    hash = fnv1a(`${path}${SEP}${fileHashes[path]}${SEP}`, hash)
  }
  // Mix the entry count in too: it distinguishes an empty map from a map whose
  // entries happen to hash back to the basis.
  hash = fnv1a(`${SEP}${paths.length}`, hash)
  return hash.toString(16).padStart(8, "0")
}
