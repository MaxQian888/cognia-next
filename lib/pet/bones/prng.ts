// Deterministic, dependency-free PRNG used to derive the pet's appearance from a
// stable account identifier (FNV-1a hash → Mulberry32 generator). Same input ⇒
// same stream, on every device and every run — no server, no persistence. Ported
// from the well-known reference implementations.

const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193

/** 32-bit FNV-1a hash of a string. */
export function fnv1a(input: string): number {
  let hash = FNV_OFFSET
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, FNV_PRIME)
  }
  return hash >>> 0
}

/** Mulberry32 — a fast 32-bit seeded generator returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Build a generator from a salted string seed. */
export function seededRng(salt: string, key: string): () => number {
  return mulberry32(fnv1a(`${salt}:${key}`))
}

/** Pick one element from a non-empty list using the generator. */
export function pick<T>(rng: () => number, list: readonly T[]): T {
  return list[Math.floor(rng() * list.length)]
}

/** Inclusive integer in [min, max]. */
export function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1))
}

/** Fisher–Yates shuffle (returns a new array; does not mutate the input). */
export function shuffle<T>(rng: () => number, list: readonly T[]): T[] {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}
