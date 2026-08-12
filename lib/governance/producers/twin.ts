import { GOVERNANCE_CONTRACT_VERSION } from "@cognia/agent-config-types/governance"
import type { DecisionRecord } from "@/types/twin"
import { sha256Hex } from "@/lib/data/crypto"
import { createConflictSet, type GovernanceAssertion } from "@/lib/governance/conflict"
import {
  appendDecisionEvent,
  recordConflictSet,
  recordDecision,
  recordEvidenceRef,
  recordLineageEdge,
} from "@/lib/db/governance-ledger"

export interface TwinDecisionsGovernanceInput {
  twinId: string
  decisions: DecisionRecord[]
  recordedAt: number
  distillJobId?: string
  projectId?: string
}

const privacy = {
  classification: "sensitive",
  retentionClass: "twin-profile",
  contentCaptured: false,
  redactionVersion: "twin-governance-v1",
  removedFields: ["decision.context", "decision.choice", "decision.rationale", "chunk.content"],
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ")
}

export async function recordTwinDecisionsGovernance(
  input: TwinDecisionsGovernanceInput
): Promise<string[]> {
  const policyDigest = await sha256Hex("twin-distill-observation-v1")
  const policyRef = {
    namespace: "twin",
    id: "decision-extraction",
    version: "1",
    digest: policyDigest,
  }
  const scope = input.projectId ? { projectId: input.projectId } : {}
  const ref = (type: string, id: string) => ({ namespace: "cognia", type, id, scope })
  const prepared = await Promise.all(
    input.decisions.map(async (decision) => {
      const contextDigest = await sha256Hex(normalize(decision.context))
      const choiceDigest = await sha256Hex(normalize(decision.choice))
      const subjectRef = ref("twin-decision-context", `${input.twinId}:${contextDigest}`)
      const evidenceIds: string[] = []
      for (const chunkId of decision.sourceChunkIds) {
        const evidenceId = `twin-evidence:${input.twinId}:${chunkId}`
        const digest = await sha256Hex(`${input.twinId}:${chunkId}`)
        await recordEvidenceRef({
          contractVersion: GOVERNANCE_CONTRACT_VERSION,
          id: evidenceId,
          kind: "twin-chunk",
          sourceRef: ref("twin-chunk", chunkId),
          digest: { algorithm: "sha256", value: digest, canonicalization: "twin-chunk-ref-v1" },
          observedAt: input.recordedAt,
          review: { status: "unreviewed" },
          contamination: "unknown",
          privacy,
        })
        evidenceIds.push(evidenceId)
      }
      return { decision, contextDigest, choiceDigest, subjectRef, evidenceIds }
    })
  )

  const byContext = new Map<string, typeof prepared>()
  for (const item of prepared) {
    const bucket = byContext.get(item.contextDigest) ?? []
    bucket.push(item)
    byContext.set(item.contextDigest, bucket)
  }

  const ids: string[] = []
  for (const item of prepared) {
    const decisionId = `twin-observation:${input.twinId}:${item.decision.id}`
    const disputed =
      byContext
        .get(item.contextDigest)
        ?.some((candidate) => candidate.choiceDigest !== item.choiceDigest) ?? false
    await recordDecision({
      contractVersion: GOVERNANCE_CONTRACT_VERSION,
      id: decisionId,
      mode: "observed",
      kind: "twin-observation",
      subjectRef: item.subjectRef,
      question: { code: "observed-choice" },
      proposer: { kind: "agent", ref: ref("twin-distiller", input.distillJobId ?? "manual") },
      decider: { kind: "agent", ref: ref("twin-knowledge-agent", "v1") },
      basis: { evidenceRefs: item.evidenceIds, policyRefs: [policyRef], parentDecisionRefs: [] },
      resolution: {
        outcome: item.choiceDigest,
        selectedRefs: [ref("twin-decision", item.decision.id)],
        reasonCode: "distilled-observation",
        rationaleOrigin: "model-summary",
        confidence: { value: disputed ? 0.5 : 1, meaning: "extraction", source: "twin-distill" },
      },
      lifecycle: {
        state: disputed ? "disputed" : "observed",
        effectiveAt: item.decision.timestamp,
        recordedAt: input.recordedAt,
      },
      correlation: { runId: input.distillJobId },
      privacy,
    })
    if (disputed) {
      await appendDecisionEvent({
        id: `${decisionId}:disputed:${item.contextDigest}`,
        decisionId,
        type: "disputed",
        at: input.recordedAt,
        reasonCode: "contradictory-observation",
        correlation: { runId: input.distillJobId },
      })
    }
    for (const evidenceId of item.evidenceIds) {
      await recordLineageEdge({
        contractVersion: GOVERNANCE_CONTRACT_VERSION,
        id: `${decisionId}:supported-by:${evidenceId}`,
        from: ref("evidence", evidenceId),
        to: ref("decision", decisionId),
        relation: "supported-by",
        assertion: "derived",
        evidenceRefs: [evidenceId],
        policyRef,
        recordedAt: input.recordedAt,
      })
    }
    ids.push(decisionId)
  }

  for (const [contextDigest, group] of byContext) {
    const distinct = new Map(group.map((item) => [item.choiceDigest, item]))
    if (distinct.size < 2) continue
    const members = [...distinct.values()]
    for (let index = 1; index < members.length; index += 1) {
      const left = members[0]
      const right = members[index]
      const assertion = (item: (typeof members)[number]): GovernanceAssertion => ({
        assertionRef: ref("twin-decision", item.decision.id),
        subjectRef: item.subjectRef,
        predicate: { namespace: "twin-decision", key: "choice" },
        scope,
        valueDigest: item.choiceDigest,
        evidenceRefs: item.evidenceIds,
        observedAt: input.recordedAt,
        ...(item.decision.timestamp ? { validTime: { from: item.decision.timestamp } } : {}),
        authorityClass: item.decision.pinned ? "explicit-user" : "local-derived",
      })
      const choicePair = [left.choiceDigest, right.choiceDigest].sort()
      await recordConflictSet(
        createConflictSet({
          id: `twin-conflict:${input.twinId}:${contextDigest}:${choicePair.join(":")}`,
          left: assertion(left),
          right: assertion(right),
          risk: "medium",
          createdAt: input.recordedAt,
          detectorRef: ref("conflict-detector", "twin-decision-v1"),
          policyRef,
        })
      )
    }
  }
  return ids
}
