/**
 * Stable, non-reversible fingerprint of the credential an operation ran
 * under. Resource handles (files, batches, vector stores, jobs) carry it so a
 * later call can refuse to address the resource through a different key,
 * which after a rotation or an organisation switch would be another account.
 *
 * FNV-1a over UTF-8, 64-bit, hex. Synchronous on purpose: the executor
 * decides pinning before any await. Not a secret-strength hash and never
 * used as one, the value only has to be stable and unlikely to collide
 * between two keys a user actually holds.
 */

// BigInt() calls, not literals: the app targets ES2018.
const FNV_OFFSET = BigInt("0xcbf29ce484222325")
const FNV_PRIME = BigInt("0x100000001b3")
const MASK = (BigInt(1) << BigInt(64)) - BigInt(1)

export function credentialAffinityOf(secret: string | undefined | null): string {
  if (!secret) return "keyless"
  let hash = FNV_OFFSET
  for (const byte of new TextEncoder().encode(secret)) {
    hash ^= BigInt(byte)
    hash = (hash * FNV_PRIME) & MASK
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`
}
