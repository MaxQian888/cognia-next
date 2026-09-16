/**
 * The in-memory evidence resolver the offline tests and the labelled mock path
 * use: an artifact is readable when `readable` says so, and its content must
 * still hash to the reference.
 */

import type { EvidenceRef } from "../contracts/schemas"
import type { EvidenceCheck, EvidenceResolver } from "../workflows/ports"
import type { MemoryArtifactStore } from "./memory-artifacts"

export class MemoryEvidenceResolver implements EvidenceResolver {
  constructor(
    private readonly store: MemoryArtifactStore,
    private readonly readable: (artifactId: string, namespace: string) => boolean = () => true
  ) {}

  async resolve(ref: EvidenceRef): Promise<EvidenceCheck> {
    const item = this.store.items.get(ref.artifact_id)
    if (!item) return { ok: false, reason: "missing" }
    if (!this.readable(ref.artifact_id, item.namespace))
      return { ok: false, reason: "not_readable" }
    if (item.artifact.contentSha256 !== ref.content_sha256) {
      return { ok: false, reason: "hash_mismatch" }
    }
    return { ok: true }
  }
}
