// Maps a model's relative file paths to blob object URLs. This is the seam the
// engine loads through: `ModelSettings.replaceFiles` rewrites every referenced
// resource path to the object URL produced here. URLs are created eagerly at
// construction so revocation bookkeeping is trivial (`revokeAll` frees the lot).

import type { ModelFileEntry } from "./types"

/**
 * Normalize a path for comparison and lookup: backslashes → slashes, strip a
 * leading "./", collapse repeated slashes, and lowercase. Lowercasing makes
 * lookups case-insensitive (model3.json refs sometimes differ in case from the
 * on-disk names); callers keep the original spelling for display separately.
 */
export function normalizePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/")
    .toLowerCase()
}

export interface UrlResolverDeps {
  createObjectURL?: (blob: Blob) => string
  revokeObjectURL?: (url: string) => void
}

export interface UrlResolver {
  /** Look up the object URL for a (relative) path; undefined if unknown. */
  resolve(path: string): string | undefined
  /** Read-only view of normalized-path → object URL. */
  entries(): ReadonlyMap<string, string>
  /** Revoke every object URL this resolver created. */
  revokeAll(): void
}

/**
 * Build a resolver over `entries`. Object URLs are created eagerly (one per
 * entry) so `revokeAll` is a flat iteration with no lazy state to track.
 */
export function createUrlResolver(
  entries: ModelFileEntry[],
  deps: UrlResolverDeps = {}
): UrlResolver {
  const create = deps.createObjectURL ?? ((blob: Blob) => URL.createObjectURL(blob))
  const revoke = deps.revokeObjectURL ?? ((url: string) => URL.revokeObjectURL(url))

  const map = new Map<string, string>()
  for (const entry of entries) {
    const key = normalizePath(entry.path)
    // First writer wins on duplicate normalized keys — keep the URL stable.
    if (!map.has(key)) {
      map.set(key, create(entry.blob))
    }
  }

  return {
    resolve(path: string): string | undefined {
      return map.get(normalizePath(path))
    },
    entries(): ReadonlyMap<string, string> {
      return map
    },
    revokeAll(): void {
      for (const url of map.values()) {
        revoke(url)
      }
      map.clear()
    },
  }
}
