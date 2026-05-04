/**
 * Merkle map helpers for the wiki indexer.
 *
 * The orchestrator builds a `Record<filePath, sha256>` of every included
 * file on every refresh; comparing the new map against the persisted
 * `wikiManifest.fileHashes` reveals which files have actually changed
 * since the last build (added / changed / removed). Cursor and DeepWiki
 * both converged on this pattern — incremental indexing beats full
 * re-indexing by an order of magnitude in steady-state.
 *
 * Hashing uses SHA-256 (the same primitive `lib/data/crypto.ts:sha256Hex`
 * exposes); we re-implement it inline so this module has zero deps and
 * works inside the standalone Node bundle without dragging in the backup
 * encryption surface.
 */

/**
 * Cross-runtime SubtleCrypto. Browser ships `crypto.subtle`; Node provides
 * it via `node:crypto.webcrypto.subtle`. The lazy import keeps the cost
 * off code paths that never hash.
 */
async function getSubtle(): Promise<SubtleCrypto> {
  if (globalThis.crypto?.subtle) return globalThis.crypto.subtle
  const { webcrypto } = await import("node:crypto")
  return webcrypto.subtle as unknown as SubtleCrypto
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

/** Hex-encoded SHA-256 of a UTF-8 string. */
export async function hashContent(content: string): Promise<string> {
  const subtle = await getSubtle()
  const encoded = new TextEncoder().encode(content)
  const digest = await subtle.digest(
    "SHA-256",
    encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer
  )
  return bytesToHex(new Uint8Array(digest))
}

/** Input row for the parallel hasher. */
export interface FileToHash {
  path: string
  content: string
}

/**
 * Build a Merkle map from a list of files. Hashes run in parallel via
 * `Promise.all` because SHA-256 is a SubtleCrypto microtask — the per-file
 * cost is dominated by string encoding, not the digest itself.
 */
export async function buildMerkleMap(
  files: readonly FileToHash[]
): Promise<Record<string, string>> {
  const entries = await Promise.all(
    files.map(async (f) => [f.path, await hashContent(f.content)] as const)
  )
  const out: Record<string, string> = {}
  for (const [path, hash] of entries) {
    out[path] = hash
  }
  return out
}

/**
 * Recompute the Merkle hash for a subset of paths (e.g. only the files the
 * walker reported as `added` or `changed`), preserving the existing entries
 * for the unchanged paths. Returns a fresh object — the input is never
 * mutated.
 */
export async function refreshSubset(
  existing: Record<string, string>,
  refreshed: readonly FileToHash[]
): Promise<Record<string, string>> {
  const next = { ...existing }
  const newHashes = await buildMerkleMap(refreshed)
  Object.assign(next, newHashes)
  return next
}

/**
 * Drop entries from a Merkle map. Used after the orchestrator processes the
 * `removed` list from `diffManifest`. Returns a fresh object.
 */
export function dropPaths(
  map: Record<string, string>,
  paths: readonly string[]
): Record<string, string> {
  const next: Record<string, string> = {}
  const dropSet = new Set(paths)
  for (const [k, v] of Object.entries(map)) {
    if (!dropSet.has(k)) next[k] = v
  }
  return next
}
