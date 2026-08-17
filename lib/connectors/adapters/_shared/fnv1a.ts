/**
 * FNV-1a (32-bit) over a UTF-16 code-unit stream.
 *
 * Shared by the adapters that must derive a *deterministic* platform-side
 * idempotency token from the outbound job's `idempotencyKey` (Discord
 * `nonce`, QQ passive `msg_seq`): a retry of the same job has to reproduce
 * the exact same token, so nothing here may depend on time or randomness.
 *
 * NOT a security primitive — it only needs to be stable and well spread.
 * `Math.imul` keeps the multiply in int32; a plain `*` overflows past 2^53
 * and silently stops being FNV.
 */

export const FNV1A_OFFSET_BASIS = 0x811c9dc5
export const FNV1A_PRIME = 0x01000193

export function fnv1a32(input: string, seed: number = FNV1A_OFFSET_BASIS): number {
  let hash = seed >>> 0
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, FNV1A_PRIME) >>> 0
  }
  return hash >>> 0
}
