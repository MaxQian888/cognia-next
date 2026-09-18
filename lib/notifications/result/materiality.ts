// Notification V2 materiality — the "did anything actually change" judgment.
//
// The materialHash is the semantic identity of a result payload: the same
// facts always hash to the same value, so a re-derived summary, a coalesced
// bump, or a late re-render that produced NO new information hashes
// identically — which is exactly what suppress-if-unchanged and
// accepted-vs-duplicate both need. It is NOT a security hash (no secrets are
// being integrity-proved), so a deterministic non-cryptographic digest
// suffices and stays synchronous inside a transaction.
//
// Materiality compares a fact's hash against a baseline: the same operation,
// the same delivery slot, or the same incident. An unchanged hash means the
// "new" attempt carries nothing the platform/user hasn't already seen —
// but a FAILED prior send is never a baseline, because nothing was delivered.

import type { RunResultFact, NotificationMaterialityVerdict } from "@/types/notifications/result"
import type { NotificationDeliveryIntent } from "@/types/notifications/delivery"

/**
 * Stable stringify — sorted object keys, array order preserved, undefined
 * dropped. Deliberately tolerant (never throws on odd values: bigint →
 * string, exotic → its tag) because the hash covers already-sanitized
 * summary facts, not arbitrary user structures.
 */
export function stableStringify(value: unknown): string {
  if (value === null) return "null"
  switch (typeof value) {
    case "boolean":
    case "number":
      return JSON.stringify(value)
    case "string":
      return JSON.stringify(value)
    case "bigint":
      return JSON.stringify(String(value))
    case "undefined":
    case "function":
    case "symbol":
      return "null"
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`
  }
  const obj = value as Record<string, unknown>
  if (Object.getPrototypeOf(obj) !== Object.prototype && Object.getPrototypeOf(obj) !== null) {
    return JSON.stringify(Object.prototype.toString.call(obj))
  }
  const keys = Object.keys(obj).sort()
  const parts: string[] = []
  for (const key of keys) {
    const child = obj[key]
    if (child === undefined) continue
    parts.push(`${JSON.stringify(key)}:${stableStringify(child)}`)
  }
  return `{${parts.join(",")}}`
}

/**
 * FNV-1a 64-bit → hex, over the stable string. Deterministic, synchronous,
 * collision-resistant enough for a materiality signal (we compare equality,
 * we do not adversarially hunt collisions). Doubled into a 128-bit digest by
 * hashing forward + reversed so a single-bit difference avalanches twice.
 */
export function stableHash(value: unknown): string {
  const text = typeof value === "string" ? value : stableStringify(value)
  // `BigInt("0x…")` string form — the `n` literal is ES2020+ syntax and the
  // repo targets ES2018; the hex string keeps the exact 64-bit constants.
  const FNV_OFFSET = BigInt("0xcbf29ce484222325")
  const FNV_PRIME = BigInt("0x100000001b3")
  const MASK = BigInt("0xffffffffffffffff")
  const forward = fnv(text, FNV_OFFSET, FNV_PRIME, MASK)
  const reversed = fnv(text.split("").reverse().join(""), FNV_OFFSET, FNV_PRIME, MASK)
  return `${forward.toString(16).padStart(16, "0")}${reversed.toString(16).padStart(16, "0")}`
}

function fnv(text: string, offset: bigint, prime: bigint, mask: bigint): bigint {
  let hash = offset
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i))
    hash = (hash * prime) & mask
  }
  return hash
}

/**
 * The material hash of a fact set — what makes a result materially new.
 * Covers the fact kinds + texts + classifications, so a re-order of the same
 * facts hashes identically (order is presentation, not substance) while any
 * added/changed/redacted fact changes it.
 */
export function materialHashOfFacts(facts: readonly RunResultFact[]): string {
  const canonical = facts
    .map((f) => ({
      k: f.kind,
      t: f.text,
      c: f.classification,
      a: f.artifactRef,
      r: f.redacted === true,
    }))
    .sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)))
  return stableHash(canonical)
}

/**
 * Judge whether a candidate fact set is materially new against the intents
 * already occupying its delivery slot / operation. A baseline is a prior
 * intent's accepted contentHash — but ONLY when that intent actually
 * delivered (accepted); a failed/unknown prior send proves nothing was
 * delivered, so it can never make a fresh attempt immaterial.
 */
export function judgeMateriality(input: {
  candidateFacts: readonly RunResultFact[]
  /** Prior intents for the same slot/operation, newest first. */
  baselines: readonly NotificationDeliveryIntent[]
}): NotificationMaterialityVerdict {
  const materialHash = materialHashOfFacts(input.candidateFacts)
  // Only an ACCEPTED send is a baseline — a failed or unknown prior attempt
  // delivered nothing, so suppressing on it would silently drop real news.
  const delivered = input.baselines.find((b) => b.status === "accepted")
  if (!delivered) {
    return { material: true, materialHash, baselineKind: "none" }
  }
  if (delivered.payload.contentHash === materialHash) {
    return {
      material: false,
      materialHash,
      baselineKind: delivered.slotKey ? "same-slot" : "same-operation",
      reason: "unchanged",
    }
  }
  return { material: true, materialHash, baselineKind: "same-slot" }
}
