/**
 * Idempotent operation access (SPEC §7): the idempotency key binds
 * workspace/project/principal/action/inputDigest. Same key + same input
 * replays the stored result; same key + different input is a 409 conflict.
 *
 * Concurrency: the claim is a pending row inserted inside BEGIN IMMEDIATE.
 * The primary key (workspace,project,principal,key) serializes concurrent
 * submitters — exactly one wins the insert and computes; the others observe
 * the pending row and wait for it to reach a terminal state, then replay or
 * retry. compute() therefore never runs twice for the same claim.
 */
import { WorkbenchError, ERROR_CODES, utcNowIso } from "@latexwb/contracts";
import { inTransaction, type Row, type WorkbenchStore } from "@latexwb/storage";
import type { RequestContext } from "./context.ts";

export interface IdempotentResult<T> {
  result: T;
  replayed: boolean;
}

export interface IdempotencyOptions {
  /**
   * How long a non-winning submitter waits for the winner's pending record to
   * reach completed/failed before giving up. Defaults to 60s; the caller's
   * AbortSignal always bounds the wait independently.
   */
  waitTimeoutMs?: number;
  /** Poll interval while waiting on a pending record. */
  pollIntervalMs?: number;
}

function sleepMs(ms: number): void {
  // Atomics.wait blocks the current thread without a busy loop; legal on the
  // main thread in Node.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

interface ClaimOutcome {
  kind: "claimed" | "replay" | "wait";
  row?: Row;
}

export function runIdempotent<T>(
  store: WorkbenchStore,
  ctx: RequestContext,
  projectId: string,
  action: string,
  inputDigest: string,
  compute: () => T,
  options: IdempotencyOptions = {},
): IdempotentResult<T> {
  const scope = { workspaceId: ctx.workspaceId, projectId };
  const waitDeadline = Date.now() + (options.waitTimeoutMs ?? 60_000);
  const pollMs = options.pollIntervalMs ?? 10;

  for (;;) {
    const claim = inTransaction(store.db, (): ClaimOutcome => {
      const existing = store.getIdempotencyRecord(scope, ctx.principalId, ctx.idempotencyKey);
      if (existing === null) {
        store.putIdempotencyRecord(scope, {
          principalId: ctx.principalId,
          idempotencyKey: ctx.idempotencyKey,
          action,
          inputDigest,
          state: "pending",
          resultJson: null,
          createdAt: utcNowIso(),
        });
        return { kind: "claimed" };
      }
      if (existing["action"] !== action || existing["input_digest"] !== inputDigest) {
        throw new WorkbenchError(
          ERROR_CODES.IDEMPOTENCY_CONFLICT,
          `idempotency key ${ctx.idempotencyKey} was already used with a different action or input`,
          { retryable: false },
        );
      }
      const state = existing["state"] as string;
      if (state === "completed") {
        return { kind: "replay", row: existing };
      }
      if (state === "failed") {
        // Same-input retry: we hold the immediate write lock, so flipping
        // failed→pending here cannot race another claimant.
        store.updateIdempotencyRecord(scope, ctx.principalId, ctx.idempotencyKey, {
          state: "pending",
          resultJson: null,
        });
        return { kind: "claimed" };
      }
      // state === "pending": another caller holds the claim.
      return { kind: "wait" };
    });

    if (claim.kind === "replay" && claim.row !== undefined) {
      return {
        result: JSON.parse(claim.row["result_json"] as string) as T,
        replayed: true,
      };
    }

    if (claim.kind === "claimed") {
      let result: T;
      try {
        result = compute();
      } catch (error) {
        // Failed claims are retriable by a later same-input submission.
        store.updateIdempotencyRecord(scope, ctx.principalId, ctx.idempotencyKey, {
          state: "failed",
          resultJson: null,
        });
        throw error;
      }
      store.updateIdempotencyRecord(scope, ctx.principalId, ctx.idempotencyKey, {
        state: "completed",
        resultJson: JSON.stringify(result ?? null),
      });
      return { result, replayed: false };
    }

    // claim.kind === "wait"
    if (ctx.signal.aborted) {
      throw new WorkbenchError(
        ERROR_CODES.RUNTIME_UNAVAILABLE,
        `aborted while waiting on pending idempotency record ${ctx.idempotencyKey}`,
        { retryable: true },
      );
    }
    if (Date.now() >= waitDeadline) {
      throw new WorkbenchError(
        ERROR_CODES.RUNTIME_UNAVAILABLE,
        `timed out waiting on pending idempotency record ${ctx.idempotencyKey}`,
        { retryable: true },
      );
    }
    sleepMs(pollMs);
  }
}
