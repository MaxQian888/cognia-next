/**
 * Durable single-shot jobs for M3 service surfaces (bibliography, assets,
 * checks). Each call is a real jobs-table lifecycle — queued → claimed →
 * succeeded/failed — with artifacts and evidence published inside the same
 * finalize transaction, so the outbox and artifact rows never diverge.
 *
 * Dedup follows the build-cache convention: a previously SUCCEEDED job for
 * the same (action, inputDigest) replays its stored resultJson instead of
 * re-executing (the artifacts/evidence it published are already durable).
 */
import {
  canonicalJson,
  digestJson,
  ERROR_CODES,
  WorkbenchError,
} from "@latexwb/contracts";
import type { BlobStore, Scope, WorkbenchStore } from "@latexwb/storage";
import type { RequestContext } from "./context.ts";
import { insertArtifactRows, type CollectedArtifact } from "./artifacts.ts";
import { JobService } from "./jobs.ts";
import { recordEvidence, type EvidenceInput } from "./evidence.ts";

export interface ServiceJobOutput {
  /** Stored verbatim (canonical JSON) as the job's resultJson.result. */
  result: unknown;
  artifacts?: CollectedArtifact[];
  evidence?: EvidenceInput[];
  /**
   * When set, the job finalizes FAILED — but `artifacts`/`evidence` still
   * publish inside the same transaction (a failed compile keeps its log).
   */
  failWith?: WorkbenchError;
  /** Extra scoped writes inside the same finalize transaction (e.g. the
   * `checks` rows backing a CheckReport artifact). */
  publishExtra?: (() => void) | undefined;
}

export async function runServiceJob<T>(options: {
  store: WorkbenchStore;
  blobs: BlobStore;
  ctx: RequestContext;
  scope: Scope;
  /** Job action label, e.g. "bibliography.audit". */
  action: string;
  snapshotId: string;
  targetId?: string | null;
  /** Canonical input — participates in the dedup digest. */
  input: unknown;
  /** Optional caller-provided JobService (tests may share one worker id). */
  jobs?: JobService | undefined;
  compute: (jobId: string) => Promise<ServiceJobOutput> | ServiceJobOutput;
}): Promise<{ jobId: string; result: T }> {
  const { store, blobs, ctx, scope, action, snapshotId, input } = options;
  const jobs = options.jobs ?? new JobService(store, `svc-${process.pid}`);
  const inputDigest = digestJson({ action, snapshotId, input });

  // Cache-hit replay: the prior job's artifacts/evidence are durable.
  const prior = store.latestSucceededByDigest(scope, action, inputDigest);
  if (prior !== null) {
    const parsed = JSON.parse(prior["result_json"] as string) as { result: T };
    return { jobId: prior["job_id"] as string, result: parsed.result };
  }

  const job = jobs.enqueue(scope, {
    principalId: ctx.principalId,
    action,
    inputDigest,
    inputJson: canonicalJson(input),
    snapshotId,
    targetId: options.targetId ?? null,
  });
  const token = jobs.claimSpecific(scope, job.jobId, 60_000);
  if (token === null) {
    throw new WorkbenchError(
      ERROR_CODES.RUNTIME_UNAVAILABLE,
      `service job ${job.jobId} could not be claimed`,
      { retryable: true },
    );
  }

  let output: ServiceJobOutput;
  try {
    output = await options.compute(job.jobId);
  } catch (error) {
    jobs.finalize(scope, job.jobId, token, {
      state: "failed",
      errorCode: error instanceof WorkbenchError ? error.code : ERROR_CODES.INVALID_REQUEST,
      resultJson: canonicalJson({
        error: error instanceof Error ? error.message : String(error),
      }),
    });
    throw error;
  }
  const finalized = jobs.finalize(
    scope,
    job.jobId,
    token,
    output.failWith !== undefined
      ? {
          state: "failed",
          errorCode: output.failWith.code,
          resultJson: canonicalJson({ error: output.failWith.message, result: output.result }),
        }
      : { state: "succeeded", resultJson: canonicalJson({ result: output.result }) },
    () => {
      if (output.artifacts !== undefined && output.artifacts.length > 0) {
        insertArtifactRows({
          store,
          scope,
          snapshotId,
          targetId: options.targetId ?? null,
          jobId: job.jobId,
          artifacts: output.artifacts,
        });
      }
      for (const ev of output.evidence ?? []) {
        recordEvidence({ store, blobs, scope, input: ev });
      }
      output.publishExtra?.();
    },
  );
  if (!finalized) {
    throw new WorkbenchError(
      ERROR_CODES.RUNTIME_UNAVAILABLE,
      `service job ${job.jobId} lost its finalize race`,
      { retryable: true },
    );
  }
  if (output.failWith !== undefined) throw output.failWith;
  return { jobId: job.jobId, result: output.result as T };
}
