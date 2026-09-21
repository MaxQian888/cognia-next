/**
 * The approval half of a delegate run (ADR-0188 B4, D21, API-08).
 *
 * `runDelegateWorkflow` never decides anything. When it needs permission — a
 * write outside a subtask's allowed paths, or delivering a patch into the
 * user's own workspace — it asks an {@link ApprovalPort} and takes one of
 * three answers: approved, denied, or nobody has said yet. This module is that
 * port on this device, plus the one seam every surface answers through.
 *
 * # Why the id is the digest
 *
 * An approval is bound to `sha256(kind + canonical args + revision)`
 * (`delegateApprovalDigest`). The stored row's id is derived from the run and
 * that digest, so the id a surface hands back when a person clicks "approve"
 * IS what they approved. Approving a request for different paths, or the same
 * paths against a workspace that has since moved, produces a different digest,
 * a different id, and `APPROVAL_MISMATCH` — with the standing request left
 * pending and undecided (API-08).
 *
 * That also makes the port idempotent, which recovery needs: a run resumed
 * after a park asks again with the same digest and finds the decision, instead
 * of asking a second time or — worse — treating silence as consent.
 *
 * # Who may answer
 *
 * A person, through one of three doors, all of which land here:
 *
 * - the cockpit's control plane (`execution_run_control` approve / deny, via
 *   `lib/router-fusion/gate/run-control.ts`);
 * - `POST /v1/runs/{id}/resume` with a `ResumeRequest` of kind `approval`;
 * - a paired device, which routes `execution_run_control` through the same
 *   Run API path (`lib/router-fusion/api/companion-run-host.ts`).
 *
 * A model never reaches this module: the workflow's `requestedBy` is recorded
 * as provenance, never as a decision.
 */

import type {
  ApprovalPort,
  DelegateApprovalDecision,
  DelegateApprovalRequest,
} from "@cognia/router-fusion"

import {
  approvalIdFor,
  decideApproval,
  pendingApprovalOf,
  recordApprovalRequest,
} from "../db/delegate-store"
import type { FusionLedgerStore } from "../db/ledger-store"

export interface DelegateApprovalPortInput {
  store: FusionLedgerStore
  runId: string
  /** The project the run belongs to, so a deletion path can find its approvals. */
  projectId: string | null
  now?: () => number
}

/**
 * The device's {@link ApprovalPort}: every request becomes a durable row, and
 * the answer is whatever a person has recorded against that exact digest.
 */
export function createDelegateApprovalPort(input: DelegateApprovalPortInput): ApprovalPort {
  const now = input.now ?? Date.now
  return {
    async requestApproval(request: DelegateApprovalRequest): Promise<DelegateApprovalDecision> {
      // The workflow computed the digest; recomputing it here would be a
      // second implementation of the same rule that could disagree with the
      // first. What this checks is that the id it stores under is the one
      // derived from that digest, which is what a surface will present back.
      const approvalId = approvalIdFor(request.runId, request.requestDigest)
      const row = await recordApprovalRequest(input.store.db, {
        runId: request.runId,
        projectId: input.projectId,
        kind: request.kind,
        requestDigest: request.requestDigest,
        revision: request.revision,
        logicalStepId: request.logicalStepId,
        summary: request.summary,
        requestedBy: request.requestedBy,
        now: now(),
      })
      if (row.status === "approved") {
        return { status: "approved", approvalId, requestDigest: request.requestDigest }
      }
      if (row.status === "denied") {
        return {
          status: "denied",
          approvalId,
          requestDigest: request.requestDigest,
          reason: row.decisionReason,
        }
      }
      // `waiting` is the whole answer: the workflow returns
      // `waiting_for_approval` and the orchestrator parks the run on the
      // approval it names. Nothing else needs telling.
      return { status: "waiting", approvalId, requestDigest: request.requestDigest }
    },
  }
}

export type FusionApprovalRefusal =
  | "RUN_NOT_FOUND"
  /** The run is not parked on a decision (already resumed, or never waiting). */
  | "RUN_NOT_WAITING"
  /** The caller named something other than the request the run is parked on. */
  | "APPROVAL_MISMATCH"
  | "RUN_VERSION_CONFLICT"
  | "DEADLINE_EXCEEDED"

export type FusionApprovalOutcome =
  | { ok: true; decision: "approve" | "deny"; approvalId: string; version: number }
  | { ok: false; code: FusionApprovalRefusal; pendingApprovalId?: string; version?: number }

/**
 * Answer the decision a parked run is waiting on, and set it running again.
 *
 * The order is deliberate. The run's version is checked BEFORE anything is
 * written, and the digest before that, so a stale or mismatched answer leaves
 * the standing request exactly as it was — the property API-08 is about. A
 * denial resumes the run too: the workflow has to run to turn "denied" into
 * its own refusal (`SCOPE_EXPANSION_DENIED`), rather than the run being sealed
 * here by something that is not the graph.
 */
export async function decideFusionApproval(
  store: FusionLedgerStore,
  input: {
    runId: string
    /** The approval (and interrupt) id the surface presented. */
    approvalId: string | null | undefined
    decision: "approve" | "deny"
    /** The run version the caller saw, when it has one to present. */
    expectedVersion?: number
    now?: () => number
  }
): Promise<FusionApprovalOutcome> {
  const now = input.now ?? (() => Date.now())
  const run = await store.getRun(input.runId)
  if (!run) return { ok: false, code: "RUN_NOT_FOUND" }
  if (run.status !== "waiting_for_approval") {
    return { ok: false, code: "RUN_NOT_WAITING", version: run.lastSeq }
  }
  if (input.expectedVersion !== undefined && input.expectedVersion !== run.lastSeq) {
    return { ok: false, code: "RUN_VERSION_CONFLICT", version: run.lastSeq }
  }
  const pending = await pendingApprovalOf(store.db, input.runId)
  if (!pending) return { ok: false, code: "RUN_NOT_WAITING", version: run.lastSeq }
  if (!input.approvalId || input.approvalId !== pending.id) {
    return {
      ok: false,
      code: "APPROVAL_MISMATCH",
      pendingApprovalId: pending.id,
      version: run.lastSeq,
    }
  }
  const decided = await decideApproval(store.db, {
    runId: input.runId,
    approvalId: input.approvalId,
    decision: input.decision,
    reason: input.decision === "deny" ? "denied_by_person" : null,
    now: now(),
  })
  if (!decided.ok) {
    return decided.code === "APPROVAL_MISMATCH"
      ? {
          ok: false,
          code: "APPROVAL_MISMATCH",
          pendingApprovalId: decided.pendingId,
          version: run.lastSeq,
        }
      : { ok: false, code: "RUN_NOT_WAITING", version: run.lastSeq }
  }
  const resumed = await store.resumeRun(input.runId, {
    kind: "approval",
    ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
  })
  if (!resumed.ok) {
    // The decision stands — a person made it and it is durable — but the run
    // did not move. A retry finds the approval already recorded and resumes.
    return {
      ok: false,
      code: resumed.code === "RUN_NOT_FOUND" ? "RUN_NOT_FOUND" : resumed.code,
      version: run.lastSeq,
    }
  }
  return {
    ok: true,
    decision: input.decision,
    approvalId: decided.row.id,
    version: resumed.run.lastSeq,
  }
}
