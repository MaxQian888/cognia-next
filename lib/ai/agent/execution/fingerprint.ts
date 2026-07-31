// Deterministic execution fingerprint (ADR-0090 Phase 0).
//
// The fingerprint pins a resolved execution decision: same non-volatile
// inputs ⇒ same fingerprint, across processes and hosts. Determinism — not
// cryptography — is the requirement, so this is a synchronous 128-bit FNV-1a
// over a canonical (sorted-key) JSON encoding with volatile fields excluded.

/** Field names that never participate in the fingerprint. */
const VOLATILE_KEYS = new Set([
  "executionFingerprint",
  "trace",
  "traceId",
  "at",
  "timestamp",
  "issuedAt",
  "expiresAt",
  "leaseId",
  "ticketRef",
  "attemptId",
  "providerAttemptId",
  "turnId",
])

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }
  if (typeof value === "object" && value !== null) {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      if (VOLATILE_KEYS.has(key)) continue
      const child = source[key]
      if (child === undefined) continue
      out[key] = canonicalize(child)
    }
    return out
  }
  return value
}

/**
 * Canonical JSON for fingerprinting: object keys sorted recursively,
 * volatile keys and `undefined` values dropped.
 */
export function canonicalizeSpec(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

// 128-bit FNV prime = 2^88 + 2^8 + 0x3b; offset basis per the FNV spec.
// BigInt() constructor calls (not literals) — the root tsconfig targets
// ES2018, where `123n` literals are a syntax error but the runtime BigInt is
// available (lib esnext).
const FNV_PRIME_128 = (BigInt(1) << BigInt(88)) + BigInt(0x13b)
const FNV_OFFSET_128 = BigInt("0x6c62272e07bb014262b821756295c58d")
const MASK_128 = (BigInt(1) << BigInt(128)) - BigInt(1)

/** 128-bit FNV-1a over a UTF-8 string, hex-encoded (32 chars). */
function fnv1a128(input: string): string {
  const prime = FNV_PRIME_128
  let hash = FNV_OFFSET_128
  const bytes = new TextEncoder().encode(input)
  for (const byte of bytes) {
    hash ^= BigInt(byte)
    hash = (hash * prime) & MASK_128
  }
  return hash.toString(16).padStart(32, "0")
}

/**
 * Compute the deterministic fingerprint for a (partial) execution spec.
 * Callers pass the resolved spec object BEFORE stamping
 * `executionFingerprint` (the field is excluded either way).
 */
export function computeExecutionFingerprint(spec: unknown): string {
  return `aexf1-${fnv1a128(canonicalizeSpec(spec))}`
}
