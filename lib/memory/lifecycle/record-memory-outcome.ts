/**
 * Persist the governance rows a completed memory job produced.
 *
 * There used to be two implementations. The renderer ran extraction inline and
 * wrote through the transactional `bindMemoryGovernanceOutcome` with
 * `kind: "message"` evidence anchored to the turn. The worker, which only ran
 * after a crash, wrote three separate awaits with `kind: "checkpoint"` evidence
 * anchored to `recovered-job:<id>` and an audit reason of `recovered_job`.
 *
 * Now that the job is the only path, "recovered" would be a lie on every turn,
 * and the provenance timeline the inspector renders would change shape for
 * every memory the product learns. So the worker adopts the inline shape, and
 * gains the atomicity it never had.
 */

import { appendMemoryAuditEvent, bindMemoryGovernanceOutcome } from "@/lib/db/memory-governance"
import {
  consolidationAuditAction,
  consolidationOpMemoryId,
  type ConsolidationOp,
} from "@/lib/memory/consolidate/consolidator"
import type { MemoryEvidence, MemoryJob } from "@/types/memory/governance"

export interface RecordMemoryJobOutcomeInput {
  job: Pick<MemoryJob, "id" | "sessionId">
  operations: readonly ConsolidationOp[]
  contaminationState: "clean" | "external-context"
  evidence: {
    kind: MemoryEvidence["kind"]
    sourceId: string
    sourceRole?: MemoryEvidence["sourceRole"]
  }
  /** Audit reason for every row this outcome touches. */
  auditReason: string
}

export async function recordMemoryJobOutcome(input: RecordMemoryJobOutcomeInput): Promise<void> {
  for (const operation of input.operations) {
    const memoryId = consolidationOpMemoryId(operation)
    const auditAction = consolidationAuditAction(operation)
    if (!memoryId || !auditAction) continue
    const addedType =
      operation.op === "ADD" || operation.op === "CONFLICT" ? operation.memory.type : undefined
    try {
      await bindMemoryGovernanceOutcome({
        memoryId,
        patch: {
          evidenceState: "supported",
          reviewStatus:
            operation.op === "CONFLICT"
              ? "conflict"
              : addedType === "procedural"
                ? "pending_instruction"
                : "unreviewed",
          contaminationState: input.contaminationState,
          sensitivity: "normal",
        },
        evidence: {
          kind: input.evidence.kind,
          sourceId: input.evidence.sourceId,
          ...(input.job.sessionId ? { sessionId: input.job.sessionId } : {}),
          contaminationState: input.contaminationState,
          reviewed: false,
          ...(input.evidence.sourceRole ? { sourceRole: input.evidence.sourceRole } : {}),
        },
        audit: {
          action: auditAction,
          ...(input.job.sessionId ? { sessionId: input.job.sessionId } : {}),
          reason: input.auditReason,
        },
      })
    } catch {
      // `bindMemoryGovernanceOutcome` throws when the row vanished between
      // consolidation and write-back, which a user deleting a memory mid-run
      // can cause. `updateMemory` used to no-op there. Failing the whole job
      // would turn one deleted row into a retry loop, so record the gap and
      // move on.
      await appendMemoryAuditEvent({
        action: "learn-denied",
        memoryId,
        ...(input.job.sessionId ? { sessionId: input.job.sessionId } : {}),
        reason: "governance_projection_failed",
        metadata: { jobId: input.job.id },
      }).catch(() => undefined)
    }
  }
}
