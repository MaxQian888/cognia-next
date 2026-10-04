/**
 * Durable job lifecycle on top of the jobs table.
 *
 * - Claim: BEGIN IMMEDIATE queued→running CAS, writes lease + bumps fencing.
 * - Finalize: fencing-token + expected-state CAS in ONE transaction with
 *   artifact publication and the job.finished event — a late finalize from a
 *   stale worker changes nothing and publishes nothing.
 * - Cancel vs finish: whoever commits the terminal-ish transition first
 *   wins; a succeeded committed before cancel-requested makes the cancel
 *   report already-terminal.
 * - lost is terminal: marked by the lease sweeper with a fencing bump, and
 *   no transition path leads back to running. Retries are new jobs with
 *   parent_job_id.
 */
import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  ERROR_CODES,
  utcNowIso,
  WorkbenchError,
  type JobResult,
  type ToolError,
} from "@latexwb/contracts";
import {
  inTransaction,
  type Row,
  type Scope,
  type WorkbenchStore,
} from "@latexwb/storage";

export const TERMINAL_STATES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed-out",
  "lost",
]);

export type JobState =
  | "queued"
  | "running"
  | "cancel-requested"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed-out"
  | "lost";

export interface JobView {
  jobId: string;
  state: JobState;
  attempt: number;
  snapshotId: string | null;
  targetId: string | null;
  parentJobId: string | null;
  fencingToken: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  finishedAt: string | null;
  errorCode: string | null;
  resultJson: string | null;
}

function toView(row: Row): JobView {
  return {
    jobId: row["job_id"] as string,
    state: row["state"] as JobState,
    attempt: row["attempt"] as number,
    snapshotId: (row["snapshot_id"] as string | null) ?? null,
    targetId: (row["target_id"] as string | null) ?? null,
    parentJobId: (row["parent_job_id"] as string | null) ?? null,
    fencingToken: row["fencing_token"] as number,
    leaseOwner: (row["lease_owner"] as string | null) ?? null,
    leaseExpiresAt: (row["lease_expires_at"] as string | null) ?? null,
    createdAt: row["created_at"] as string,
    finishedAt: (row["finished_at"] as string | null) ?? null,
    errorCode: (row["error_code"] as string | null) ?? null,
    resultJson: (row["result_json"] as string | null) ?? null,
  };
}

function eventEnvelope(params: {
  seq: number;
  projectId: string;
  jobId: string | null;
  snapshotId: string | null;
  attempt: number | null;
  fencingToken: number | null;
  type: string;
  timestamp: string;
  payload: unknown;
}): string {
  return canonicalJson({
    schemaVersion: 1,
    seq: params.seq,
    projectId: params.projectId,
    jobId: params.jobId,
    snapshotId: params.snapshotId,
    attempt: params.attempt,
    fencingToken: params.fencingToken,
    type: params.type,
    timestamp: params.timestamp,
    payload: params.payload,
  });
}

export class JobService {
  private readonly store: WorkbenchStore;
  private readonly workerId: string;

  constructor(store: WorkbenchStore, workerId: string) {
    this.store = store;
    this.workerId = workerId;
  }

  /** Insert a queued job and emit job.queued atomically. */
  enqueue(
    scope: Scope,
    job: {
      principalId: string;
      action: string;
      inputDigest: string;
      inputJson: string;
      snapshotId: string | null;
      targetId: string | null;
      attempt?: number;
      parentJobId?: string | null;
    },
  ): JobView {
    const jobId = `job-${randomUUID()}`;
    const now = utcNowIso();
    inTransaction(this.store.db, () => {
      this.store.insertJob(scope, {
        jobId,
        principalId: job.principalId,
        action: job.action,
        inputDigest: job.inputDigest,
        inputJson: job.inputJson,
        snapshotId: job.snapshotId,
        targetId: job.targetId,
        attempt: job.attempt ?? 1,
        parentJobId: job.parentJobId ?? null,
        createdAt: now,
      });
      this.store.emitProjectEventInTx(scope, {
        jobId,
        createdAt: now,
        eventJson: (seq) =>
          eventEnvelope({
            seq,
            projectId: scope.projectId,
            jobId,
            snapshotId: job.snapshotId,
            attempt: job.attempt ?? 1,
            // No token exists until a claim — schema requires ≥1 or null.
            fencingToken: null,
            type: "job.queued",
            timestamp: now,
            payload: { state: "queued" },
          }),
      });
    });
    return toView(this.store.getJob(scope, jobId) as Row);
  }

  /** Claim a SPECIFIC queued job (cache-hit fast path, directed execution). */
  claimSpecific(scope: Scope, jobId: string, leaseMs: number): number | null {
    return inTransaction(this.store.db, () => {
      const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
      const fencingToken = this.store.claimJob(scope, jobId, this.workerId, leaseExpiresAt);
      if (fencingToken === null) return null;
      const row = this.store.getJob(scope, jobId);
      const now = utcNowIso();
      this.store.emitProjectEventInTx(scope, {
        jobId,
        createdAt: now,
        eventJson: (seq) =>
          eventEnvelope({
            seq,
            projectId: scope.projectId,
            jobId,
            snapshotId: (row?.["snapshot_id"] as string | null) ?? null,
            attempt: (row?.["attempt"] as number) ?? null,
            fencingToken,
            type: "job.started",
            timestamp: now,
            payload: { state: "running", workerId: this.workerId },
          }),
      });
      return fencingToken;
    });
  }

  /** Claim the oldest queued job for this worker. Null when queue is empty. */
  claimNext(scope: Scope, leaseMs: number): { job: JobView; fencingToken: number } | null {
    return inTransaction(this.store.db, () => {
      const row = this.store.nextQueuedJob(scope);
      if (row === null) return null;
      const jobId = row["job_id"] as string;
      const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
      const fencingToken = this.store.claimJob(scope, jobId, this.workerId, leaseExpiresAt);
      if (fencingToken === null) return null; // raced: cancel or another claim
      const now = utcNowIso();
      this.store.emitProjectEventInTx(scope, {
        jobId,
        createdAt: now,
        eventJson: (seq) =>
          eventEnvelope({
            seq,
            projectId: scope.projectId,
            jobId,
            snapshotId: (row["snapshot_id"] as string | null) ?? null,
            attempt: row["attempt"] as number,
            fencingToken,
            type: "job.started",
            timestamp: now,
            payload: { state: "running", workerId: this.workerId },
          }),
      });
      return { job: toView(this.store.getJob(scope, jobId) as Row), fencingToken };
    });
  }

  heartbeat(scope: Scope, jobId: string, fencingToken: number, leaseMs: number): boolean {
    return this.store.heartbeatJob(
      scope,
      jobId,
      fencingToken,
      new Date(Date.now() + leaseMs).toISOString(),
    );
  }

  /**
   * Cancellation entry point. Returns the resulting transition:
   * 'cancel-requested' (running; the worker must still confirm),
   * 'cancelled' (queued; terminal immediately), 'already-terminal',
   * 'cancel-requested' (idempotent repeat), or 'not-found'.
   */
  requestCancel(scope: Scope, jobId: string): string {
    return inTransaction(this.store.db, () => {
      const now = utcNowIso();
      const outcome = this.store.requestCancelJob(scope, jobId, now, now);
      if (outcome === "cancelled") {
        const row = this.store.getJob(scope, jobId);
        this.store.emitProjectEventInTx(scope, {
          jobId,
          createdAt: now,
          eventJson: (seq) =>
            eventEnvelope({
              seq,
              projectId: scope.projectId,
              jobId,
              snapshotId: (row?.["snapshot_id"] as string | null) ?? null,
              attempt: (row?.["attempt"] as number) ?? null,
              fencingToken: (row?.["fencing_token"] as number) ?? null,
              type: "job.finished",
              timestamp: now,
              payload: jobResultPayload(row, "cancelled", null, {
                code: "CANCELLED",
                message: "job cancelled while queued",
                retryable: false,
              }),
            }),
        });
      } else if (outcome === "cancel-requested") {
        const row = this.store.getJob(scope, jobId);
        this.store.emitProjectEventInTx(scope, {
          jobId,
          createdAt: now,
          eventJson: (seq) =>
            eventEnvelope({
              seq,
              projectId: scope.projectId,
              jobId,
              snapshotId: (row?.["snapshot_id"] as string | null) ?? null,
              attempt: (row?.["attempt"] as number) ?? null,
              fencingToken: (row?.["fencing_token"] as number) ?? null,
              type: "job.progress",
              timestamp: now,
              payload: {
                stage: "cancel-requested",
                message: "cancellation requested; waiting for worker confirmation",
                completedUnits: 0,
                totalUnits: null,
              },
            }),
        });
      }
      return outcome;
    });
  }

  /**
   * Terminal finalize. expectedStates encodes the legal source states for
   * the requested outcome; on success, `publish` runs inside the same
   * transaction (artifact rows + events), so a stale worker publishes
   * nothing. Returns false when the CAS lost.
   */
  finalize(
    scope: Scope,
    jobId: string,
    fencingToken: number,
    outcome: {
      state: "succeeded" | "failed" | "cancelled" | "timed-out";
      resultJson?: string | null;
      errorCode?: string | null;
    },
    publish?: () => void,
  ): boolean {
    return inTransaction(this.store.db, () => {
      const expectedStates =
        outcome.state === "cancelled" || outcome.state === "timed-out"
          ? ["running", "cancel-requested"]
          : ["running"];
      const finishedAt = utcNowIso();
      const ok = this.store.finalizeJob(scope, jobId, fencingToken, expectedStates, {
        state: outcome.state,
        resultJson: outcome.resultJson ?? null,
        errorCode: outcome.errorCode ?? null,
        finishedAt,
      });
      if (!ok) return false;
      publish?.();
      const row = this.store.getJob(scope, jobId);
      this.store.emitProjectEventInTx(scope, {
        jobId,
        createdAt: finishedAt,
        eventJson: (seq) =>
          eventEnvelope({
            seq,
            projectId: scope.projectId,
            jobId,
            snapshotId: (row?.["snapshot_id"] as string | null) ?? null,
            attempt: (row?.["attempt"] as number) ?? null,
            fencingToken,
            type: "job.finished",
            timestamp: finishedAt,
            payload: jobResultPayload(
              row,
              outcome.state,
              outcome.errorCode ?? null,
              null,
              this.store.listArtifactsByJob(scope, jobId).map((a) => a["artifact_id"] as string),
            ),
          }),
      });
      return true;
    });
  }

  /** Lease sweeper: mark expired running/cancel-requested jobs lost. */
  sweepExpiredLeases(scope: Scope): string[] {
    const now = utcNowIso();
    return inTransaction(this.store.db, () => {
      const expired = this.store.listExpiredLeases(scope, now);
      const lostIds: string[] = [];
      for (const row of expired) {
        const jobId = row["job_id"] as string;
        if (this.store.markJobLost(scope, jobId, now)) {
          lostIds.push(jobId);
          const after = this.store.getJob(scope, jobId);
          this.store.emitProjectEventInTx(scope, {
            jobId,
            createdAt: now,
            eventJson: (seq) =>
              eventEnvelope({
                seq,
                projectId: scope.projectId,
                jobId,
                snapshotId: (row["snapshot_id"] as string | null) ?? null,
                attempt: row["attempt"] as number,
                fencingToken: (after?.["fencing_token"] as number) ?? null,
                type: "job.finished",
                timestamp: now,
                payload: jobResultPayload(after, "lost", "LEASE_EXPIRED", {
                  code: "LEASE_EXPIRED",
                  message: "worker lease expired; job marked lost",
                  retryable: true,
                }),
              }),
          });
        }
      }
      return lostIds;
    });
  }

  /** Retry a lost job as a NEW job (attempt+1) linked by parent_job_id. */
  retryLost(scope: Scope, jobId: string): JobView {
    const parent = this.store.getJob(scope, jobId);
    if (parent === null) {
      throw new WorkbenchError(ERROR_CODES.NOT_FOUND, `job ${jobId} not found`);
    }
    if ((parent["state"] as string) !== "lost") {
      throw new WorkbenchError(
        ERROR_CODES.INVALID_REQUEST,
        `job ${jobId} is ${String(parent["state"])}; only lost jobs may be retried`,
      );
    }
    return this.enqueue(scope, {
      principalId: parent["principal_id"] as string,
      action: parent["action"] as string,
      inputDigest: parent["input_digest"] as string,
      inputJson: parent["input_json"] as string,
      snapshotId: (parent["snapshot_id"] as string | null) ?? null,
      targetId: (parent["target_id"] as string | null) ?? null,
      attempt: (parent["attempt"] as number) + 1,
      parentJobId: jobId,
    });
  }

  get(scope: Scope, jobId: string): JobView | null {
    const row = this.store.getJob(scope, jobId);
    return row === null ? null : toView(row);
  }

  list(scope: Scope, limit = 200): JobView[] {
    return this.store.listJobs(scope, { limit }).map(toView);
  }
}

function jobResultPayload(
  row: Row | null,
  state: string,
  errorCode: string | null,
  error: ToolError | null,
  artifactIds: string[] = [],
): JobResult {
  const err: ToolError | null =
    error ??
    (errorCode !== null
      ? { code: errorCode, message: `job ended in state ${state}`, retryable: state === "lost" }
      : null);
  let buildResult: JobResult["buildResult"] = null;
  const resultJson = (row?.["result_json"] as string | null) ?? null;
  if (resultJson !== null) {
    try {
      const parsed = JSON.parse(resultJson) as { buildResult?: JobResult["buildResult"] };
      buildResult = parsed.buildResult ?? null;
    } catch {
      buildResult = null;
    }
  }
  return {
    kind: "job-status",
    jobId: (row?.["job_id"] as string) ?? "",
    state: state as JobResult["state"],
    snapshotId: (row?.["snapshot_id"] as string | null) ?? null,
    attempt: (row?.["attempt"] as number) ?? 1,
    resultArtifactIds: artifactIds,
    error: err,
    buildResult,
  };
}
