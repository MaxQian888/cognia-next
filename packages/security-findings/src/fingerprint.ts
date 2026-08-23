/**
 * Stable identity for a finding, across scans of the same target.
 *
 * ## Why not the scanner's own id
 *
 * Strix emits a per-run `id`, so keying on it makes every finding "new" on
 * every scan — baselines never converge and a triage decision never sticks.
 * The fingerprint is derived from the parts of a finding that describe WHICH
 * vulnerability it is, and nothing else.
 *
 * ## What is deliberately excluded
 *
 * - **Severity and CVSS.** A rescored finding is the same finding. Including
 *   them would resurface everything the moment a scanner tunes its scoring.
 * - **Description, impact, remediation, PoC.** Model-authored prose that
 *   varies run to run for an identical vulnerability.
 * - **Line numbers.** Editing a file above a finding shifts every line below
 *   it; keying on lines would report a whole file as newly vulnerable after an
 *   unrelated edit. The FILE participates, the line does not.
 *
 * ## Why a non-cryptographic hash
 *
 * This is an identity key, not a security claim: nothing trusts it to be
 * unforgeable, and a collision merges two rows in a report rather than
 * granting access to anything. FNV-1a is used because it is synchronous,
 * dependency-free and identical in the renderer and in Node — `node:crypto`
 * does not exist in the plugin panel, and `crypto.subtle` is async, which
 * would make normalization async for no benefit.
 */

import type { FindingLocation } from "./types"

/** One 32-bit FNV-1a pass over UTF-16 code units. */
function fnv1a32(text: string, basis: number): number {
  let hash = basis >>> 0
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    // `Math.imul` keeps the multiply in 32-bit space; a plain `*` overflows
    // into a float above 2^53 and silently stops being FNV.
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * 64 bits of key space, as two independent 32-bit FNV-1a passes.
 *
 * Deliberately NOT a real 64-bit FNV: JavaScript has no unsigned 64-bit
 * integer math, and emulating it through 16-bit limbs is a lot of code to get
 * subtly wrong for no gain here. Two passes with different offset bases give a
 * comparable collision profile for an identity key. The single 32-bit variant
 * used by `fnv1aHash` in `lib/git/hunk-review.ts` starts colliding around a
 * few tens of thousands of distinct values, which a long-lived findings
 * database will reach.
 */
function fnv1a64(text: string): string {
  const high = fnv1a32(text, 0x811c9dc5)
  const low = fnv1a32(text, 0x01000193)
  return high.toString(16).padStart(8, "0") + low.toString(16).padStart(8, "0")
}

/** Lower-cased, forward-slashed, whitespace-collapsed. */
function canonical(value: string | undefined): string {
  return (value ?? "").replaceAll("\\", "/").trim().toLowerCase().replace(/\s+/gu, " ")
}

/**
 * The one location a fingerprint is keyed on.
 *
 * Locations arrive unordered, and a scanner may add secondary ones between
 * runs, so the set is reduced deterministically: the lexicographically
 * smallest key wins. Taking `locations[0]` instead would make the fingerprint
 * depend on report ordering, which no scanner guarantees.
 */
export function primaryLocationKey(locations: readonly FindingLocation[]): string {
  const keys = locations
    .map((location) => {
      const file = canonical(location.file)
      if (file) return `file:${file}`
      const endpoint = canonical(location.endpoint)
      if (!endpoint) return ""
      const method = canonical(location.method)
      return method ? `http:${method} ${endpoint}` : `http:${endpoint}`
    })
    .filter((key) => key.length > 0)
    .sort()
  return keys[0] ?? ""
}

export interface FingerprintInput {
  ruleId: string
  title: string
  locations: readonly FindingLocation[]
}

/**
 * Identity of a finding WITHIN one target.
 *
 * The target is not mixed in: callers that need to separate the same
 * vulnerability on staging from production pair this with the target key (see
 * {@link findingKey}), and callers comparing one target across time do not.
 */
export function fingerprintFinding(input: FingerprintInput): string {
  const rule = canonical(input.ruleId)
  // The title participates only when there is no rule id to key on. A scanner
  // that reworded its titles must not orphan every existing triage decision.
  const discriminator = rule || canonical(input.title)
  return fnv1a64(`${discriminator} ${primaryLocationKey(input.locations)}`)
}

/**
 * Stable key for a scan target.
 *
 * Trailing slashes, the scheme, and the case of a hostname are all incidental
 * to which system was scanned. Anything unparseable falls back to the
 * canonicalized string rather than throwing: an odd target still needs a key,
 * and a wrong-but-stable key merely fails to merge two targets, whereas a
 * throw would take down the whole report.
 */
export function targetKey(raw: string): string {
  const trimmed = (raw ?? "").trim()
  if (!trimmed) return ""
  try {
    const url = new URL(trimmed)
    // A bare Windows path parses as a URL with a single-letter scheme; treat
    // anything without a host as a path, not a URL.
    if (!url.hostname) return canonical(trimmed).replace(/\/+$/u, "")
    const port = url.port ? `:${url.port}` : ""
    const path = url.pathname.replace(/\/+$/u, "")
    return canonical(`${url.hostname}${port}${path}`)
  } catch {
    return canonical(trimmed).replace(/\/+$/u, "")
  }
}

/** Identity of a finding across targets — what triage and suppression key on. */
export function findingKey(target: string, fingerprint: string): string {
  return `${target} ${fingerprint}`
}
