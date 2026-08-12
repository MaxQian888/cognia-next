import { GOVERNANCE_CONTRACT_VERSION } from "@cognia/agent-config-types/governance"
import type { CapturedItem } from "@/types/capture"
import { sha256Hex } from "@/lib/data/crypto"
import { recordEvidenceRef, recordProvenanceEnvelope } from "@/lib/db/governance-ledger"

const privacy = {
  classification: "sensitive",
  retentionClass: "capture-metadata",
  contentCaptured: false,
  redactionVersion: "capture-governance-v1",
  removedFields: ["capture.text", "capture.sourceUrl", "capture.sourceApp", "capture.enrichment"],
}

const ref = (type: string, id: string) => ({ namespace: "cognia", type, id })

/** Record a content-free evidence and provenance projection for one persisted capture. */
export async function recordCaptureGovernance(item: CapturedItem): Promise<string> {
  const evidenceId = `capture-evidence:${item.id}`
  const digest = await sha256Hex(`${item.kind}:${item.fingerprint}`)
  await recordEvidenceRef({
    contractVersion: GOVERNANCE_CONTRACT_VERSION,
    id: evidenceId,
    kind: "capture",
    sourceRef: ref("capture", item.id),
    digest: { algorithm: "sha256", value: digest, canonicalization: "capture-fingerprint-v1" },
    observedAt: item.capturedAt,
    review: { status: "unreviewed" },
    contamination: "external-context",
    privacy,
  })
  await recordProvenanceEnvelope({
    contractVersion: GOVERNANCE_CONTRACT_VERSION,
    eventId: `capture-provenance:${item.id}`,
    eventType: "capture.persisted",
    source: "cognia://capture/manager",
    subjectRef: ref("capture", item.id),
    occurredAt: item.capturedAt,
    recordedAt: item.capturedAt,
    correlation: {},
    actorRefs: [ref("device", "local")],
    decisionRefs: [],
    evidenceRefs: [evidenceId],
    inputRefs: [],
    outputRefs: [ref("capture", item.id)],
    policyRefs: [],
    privacy,
    data: { kind: item.kind, enriched: Boolean(item.enrichment) },
  })
  return evidenceId
}
