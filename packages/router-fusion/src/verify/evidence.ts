/**
 * Evidence reference checks (DESIGN §9.3, INV-12, PAN-05).
 *
 * A candidate's claim may cite evidence, and a citation is only worth what the
 * runtime can prove about it: the artifact exists in this tenant, this run may
 * read it, and its content still hashes to what the reference pinned. The same
 * URL fetched twice is two pieces of evidence; a reference to content that has
 * changed is not the evidence it claims to be.
 *
 * A reference that fails any check is dropped from the claim it supported and
 * recorded with the reason. It is never repaired, and it never counts towards
 * a claim being supported.
 */

import { EvidenceRefSchema, type EvidenceRef } from "../contracts/schemas"
import type { EvidenceRejection, EvidenceResolver } from "../workflows/ports"

export interface RejectedEvidence {
  ref: unknown
  reason: EvidenceRejection
}

export interface EvidenceVerdict {
  valid: EvidenceRef[]
  rejected: RejectedEvidence[]
}

/** Check every reference; malformed ones are rejected without asking the resolver. */
export async function checkEvidenceRefs(
  refs: readonly unknown[],
  resolver: EvidenceResolver
): Promise<EvidenceVerdict> {
  const valid: EvidenceRef[] = []
  const rejected: RejectedEvidence[] = []
  const seen = new Set<string>()
  for (const raw of refs) {
    const parsed = EvidenceRefSchema.safeParse(raw)
    if (!parsed.success) {
      rejected.push({ ref: raw, reason: "malformed" })
      continue
    }
    const ref = parsed.data
    const key = `${ref.artifact_id}\u0000${ref.content_sha256}\u0000${ref.locator}`
    if (seen.has(key)) continue
    seen.add(key)
    const check = await resolver.resolve(ref)
    if (check.ok) valid.push(ref)
    else rejected.push({ ref, reason: check.reason })
  }
  return { valid, rejected }
}
