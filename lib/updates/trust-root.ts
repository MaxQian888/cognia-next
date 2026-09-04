/**
 * The compiled-in root of trust for the update catalog.
 *
 * Shipping the root inside the app is the whole point: it is the one key set
 * an attacker cannot swap by controlling the network. The operator generates
 * it once with the release tooling and injects it at build time through
 * `NEXT_PUBLIC_UPDATE_TRUST_ROOT` (base64-encoded JSON of the root payload).
 *
 * When no root is configured the catalog is treated as unavailable rather than
 * as unsigned-but-acceptable. Every adapter then falls back to its own source,
 * and nothing is ever installed on the strength of unverified metadata.
 */

import type { CatalogRootPayload, CatalogTrustState } from "./catalog-types"

export const UPDATE_TRUST_ROOT_ENV = "NEXT_PUBLIC_UPDATE_TRUST_ROOT"

function decodeBase64(value: string): string {
  if (typeof atob === "function") return atob(value)
  const buffer = (
    globalThis as { Buffer?: { from(s: string, enc: string): { toString(e: string): string } } }
  ).Buffer
  if (buffer) return buffer.from(value, "base64").toString("utf8")
  throw new Error("no base64 decoder available")
}

/** Parse a root payload, rejecting anything structurally wrong. */
export function parseTrustRoot(raw: string | undefined): CatalogRootPayload | null {
  if (!raw) return null
  try {
    const json = raw.trim().startsWith("{") ? raw : decodeBase64(raw)
    const parsed = JSON.parse(json) as CatalogRootPayload
    if (parsed?._type !== "root") return null
    if (!parsed.keys || typeof parsed.keys !== "object") return null
    if (!parsed.roles?.root || !parsed.roles.targets) return null
    if (typeof parsed.version !== "number") return null
    if (typeof parsed.expires !== "string") return null
    return parsed
  } catch {
    return null
  }
}

/** The root this build ships with, or null when the operator configured none. */
export function compiledTrustRoot(): CatalogRootPayload | null {
  return parseTrustRoot(process.env.NEXT_PUBLIC_UPDATE_TRUST_ROOT)
}

/** Fresh trust state seeded from the compiled-in root. */
export function initialTrustState(
  root: CatalogRootPayload | null = compiledTrustRoot()
): CatalogTrustState | null {
  if (!root) return null
  return { root, seenVersions: { root: root.version } }
}
