/**
 * Workflow controller (M2-B): start / drive / resume / cancel over
 * host-owned workflow definitions and the static operation registry.
 *
 * Persistence is the resume contract: every step run is stored with its
 * inputDigest; a completed run for (nodeId, inputDigest) is REUSED on
 * re-drive, so a crash mid-run never re-executes an expensive step (no
 * second build job, no double patch apply). A running workflow's definition
 * is read from CAS by definitionHash — editing the JSON on disk cannot
 * retroactively change it.
 *
 * The drive loop only runs while the row is `running`. waiting-* persists
 * and STOPS (no worker lease is held). Terminals are one-way; a transition
 * cap (200/drive call) blocks cyclic definitions instead of spinning.
 */
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import {
  canonicalJson,
  digestJson,
  ERROR_CODES,
  NotImplementedError,
  utcNowIso,
  WorkbenchError,
} from "@latexwb/contracts";
import { inTransaction, type BlobStore, type Row, type Scope, type WorkbenchStore } from "@latexwb/storage";
import { requireCapability } from "./capabilities.ts";
import type { RequestContext } from "./context.ts";
import {
  assertOperationSupported,
  assertRegistryConsistency,
  unsupportedOperationReason,
  type OperationRunEnv,
  type PendingRequest,
  type StepDecision,
  type WorkflowContext,
} from "./operations.ts";
import { loadDefinitionFromCas, loadWorkflowDefinition } from "./workflow-defs.ts";
import type { BuildService } from "./build.ts";

export interface WorkflowDeps {
  store: WorkbenchStore;
  blobs: BlobStore;
  repoRoot: string;
  buildService: BuildService;
  /** Host request context — ops run under it; never read from the workflow. */
  ctx: RequestContext;
  /** Test seam for outbound fetches (venue.verify-current). */
  fetchImpl?: import("./net.ts").Fetcher;
}

const MAX_TRANSITIONS = 200;

/** The record stored on a finished step run — enough to replay the edge. */
interface StepRecord {
  kind: "success" | "failure";
  result?: unknown;
  reason?: string;
  contextUpdates?: Partial<WorkflowContext>;
  next: string;
}

export interface WorkflowStatus {
  workflowId: string;
  definitionId: string;
  definitionHash: string;
  state: string;
  currentNode: string;
  context: WorkflowContext;
  budget: unknown;
  pendingRequest: PendingRequest | null;
  steps: Array<{
    stepRunId: string;
    nodeId: string;
    operationId: string | null;
    state: string;
    jobId: string | null;
  }>;
}

function definedOnly(updates: Partial<WorkflowContext> | undefined): Partial<WorkflowContext> {
  const out: Partial<WorkflowContext> = {};
  if (updates === undefined) return out;
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

function workflowRow(store: WorkbenchStore, scope: Scope, workflowId: string): Row {
  const row = store.getWorkflow(scope, workflowId);
  if (row === null) {
    throw new WorkbenchError(ERROR_CODES.NOT_FOUND, `workflow ${workflowId} not found in scope`);
  }
  return row;
}

export function startWorkflow(
  deps: WorkflowDeps,
  options: {
    scope: Scope;
    definitionId: string;
    context?: Partial<WorkflowContext>;
  },
): Promise<WorkflowStatus> {
  const { store, blobs, ctx } = deps;
  const { scope } = options;
  requireCapability(ctx, "project.write");
  assertRegistryConsistency(deps.repoRoot);
  const project = store.getProject(scope);
  if (project === null) {
    throw new WorkbenchError(ERROR_CODES.NOT_FOUND, `project ${scope.projectId} not found`);
  }
  const def = loadWorkflowDefinition(deps.repoRoot, options.definitionId);
  const stored = blobs.put(def.bytes);
  if (stored.hash !== def.hash) {
    throw new WorkbenchError(
      ERROR_CODES.DIGEST_MISMATCH,
      `workflow definition stored under ${stored.hash}, expected ${def.hash}`,
    );
  }
  const context: WorkflowContext = {
    snapshotId: options.context?.snapshotId ?? (project["head_snapshot_id"] as string | null),
    targetId: options.context?.targetId ?? null,
    pdfArtifactId: options.context?.pdfArtifactId ?? null,
  };
  // canonicalJson rejects undefined — optional fields only appear when set.
  for (const key of [
    "patchId",
    "causeId",
    "baselineArtifactId",
    "releaseProfileId",
    "releaseId",
  ] as const) {
    const value = options.context?.[key];
    if (value !== undefined) context[key] = value;
  }
  const workflowId = `wf-${randomUUID()}`;
  const now = utcNowIso();
  store.insertWorkflow(scope, {
    workflowId,
    definitionId: def.spec.id,
    definitionVersion: def.spec.version,
    definitionHash: def.hash,
    currentNode: def.spec.initial,
    state: "running",
    contextJson: canonicalJson(context),
    budgetJson: canonicalJson({ patchApplications: 0, causeAttempts: {} }),
    createdAt: now,
    updatedAt: now,
  });
  return driveWorkflow(deps, scope, workflowId).then(() =>
    getWorkflowStatus(store, scope, workflowId),
  );
}

/** Run the machine until it waits, blocks, or reaches a terminal. */
export async function driveWorkflow(
  deps: WorkflowDeps,
  scope: Scope,
  workflowId: string,
): Promise<void> {
  const { store, blobs } = deps;
  let transitions = 0;
  for (;;) {
    const row = workflowRow(store, scope, workflowId);
    if ((row["state"] as string) !== "running") return;
    transitions += 1;
    if (transitions > MAX_TRANSITIONS) {
      store.updateWorkflow(scope, workflowId, {
        state: "blocked",
        updatedAt: utcNowIso(),
      });
      const stepNote = canonicalJson({
        kind: "failure",
        reason: `transition cap exceeded (${MAX_TRANSITIONS} transitions in one drive call) — cyclic definition?`,
      });
      store.failRunningSteps(scope, workflowId, stepNote);
      return;
    }
    const spec = loadDefinitionFromCas(blobs, row["definition_hash"] as string);
    const currentNode = row["current_node"] as string;
    if (spec.terminals.includes(currentNode)) {
      store.updateWorkflow(scope, workflowId, { state: currentNode, updatedAt: utcNowIso() });
      return;
    }
    const node = spec.nodes.find((n) => n.id === currentNode);
    if (node === undefined) {
      store.updateWorkflow(scope, workflowId, { state: "blocked", updatedAt: utcNowIso() });
      return;
    }
    const context = JSON.parse(row["context_json"] as string) as WorkflowContext;
    const resolved: Record<string, string | null> = {};
    for (const [key, selector] of Object.entries(node.inputBindings)) {
      if (selector === undefined) continue;
      resolved[key] =
        ((context as unknown as Record<string, unknown>)[
          selector.slice("context.".length)
        ] as string | null | undefined) ?? null;
    }
    const inputDigest = digestJson({ nodeId: node.id, resolved, context });

    // Resume contract: a completed run for (node, same inputs) is reused —
    // its stored edge and context updates replay without re-executing.
    const prior = store.findWorkflowStepRun(
      scope, workflowId, node.id, inputDigest, "completed",
    );
    if (prior !== null) {
      const stored = JSON.parse(prior["result_json"] as string) as StepRecord;
      const merged = { ...context, ...definedOnly(stored.contextUpdates) };
      inTransaction(store.db, () => {
        store.updateWorkflow(scope, workflowId, {
          currentNode: stored.next,
          contextJson: canonicalJson(merged),
          updatedAt: utcNowIso(),
        });
      });
      continue;
    }

    // Close leftover runs for this node+input — a crashed 'running' or a
    // superseded 'waiting-*' must not shadow the fresh execution.
    inTransaction(store.db, () => {
      store.failRunningSteps(
        scope, workflowId,
        canonicalJson({ kind: "failure", reason: "interrupted: superseded by a new drive" }),
      );
    });
    const staleWaiting = store.findWorkflowStepRun(scope, workflowId, node.id, inputDigest);
    if (
      staleWaiting !== null &&
      ["waiting-input", "waiting-approval"].includes(staleWaiting["state"] as string)
    ) {
      store.updateWorkflowStep(scope, workflowId, staleWaiting["step_run_id"] as string, {
        state: "superseded",
      });
    }

    const stepRunId = `step-${randomUUID()}`;
    let impl;
    try {
      impl = assertOperationSupported(deps.repoRoot, node.operationId as string);
    } catch (error) {
      const reason =
        error instanceof NotImplementedError
          ? `NOT_IMPLEMENTED: ${error.message}`
          : error instanceof WorkbenchError
            ? `${error.code}: ${error.message}`
            : String(error);
      inTransaction(store.db, () => {
        store.insertWorkflowStep(scope, {
          workflowId,
          stepRunId,
          nodeId: node.id,
          inputDigest,
          state: "failed",
          operationId: node.operationId,
          operationVersion: null,
          resultJson: canonicalJson({ kind: "failure", reason }),
        });
        store.updateWorkflow(scope, workflowId, { state: "blocked", updatedAt: utcNowIso() });
      });
      return;
    }

    store.insertWorkflowStep(scope, {
      workflowId,
      stepRunId,
      nodeId: node.id,
      inputDigest,
      state: "running",
      operationId: impl.id,
      operationVersion: impl.version,
    });
    let decision: StepDecision;
    try {
      // Each step runs under a deterministic derived idempotency key so one
    // host request can submit several different jobs (a single ctx key would
    // trip IDEMPOTENCY_CONFLICT), and a crash-resumed step replays to the
    // SAME job instead of enqueueing a second one.
    const stepCtx: RequestContext = {
      ...deps.ctx,
      idempotencyKey: `wf-${createHash("sha256").update(`${workflowId}:${node.id}:${inputDigest}`).digest("hex").slice(0, 40)}`,
    };
    const env: OperationRunEnv = {
        store,
        blobs,
        ctx: stepCtx,
        scope,
        workflowId,
        stepRunId,
        node,
        spec,
        context,
        resolved,
        buildService: deps.buildService,
        repoRoot: deps.repoRoot,
        fetchImpl: deps.fetchImpl,
      };
      decision = await impl.run(env);
    } catch (error) {
      decision = {
        kind: "failure",
        reason:
          error instanceof WorkbenchError
            ? `${error.code}: ${error.message}`
            : error instanceof Error
              ? error.message
              : String(error),
      };
    }

    const now = utcNowIso();
    if (decision.kind === "waiting-input" || decision.kind === "waiting-approval") {
      inTransaction(store.db, () => {
        store.updateWorkflowStep(scope, workflowId, stepRunId, {
          state: decision.kind,
          resultJson: canonicalJson({ kind: decision.kind, request: decision.request }),
        });
        store.updateWorkflow(scope, workflowId, { state: decision.kind, updatedAt: now });
        store.emitProjectEventInTx(scope, {
          jobId: null,
          createdAt: now,
          eventJson: (seq) =>
            canonicalJson({
              schemaVersion: 1,
              seq,
              projectId: scope.projectId,
              jobId: null,
              snapshotId: context.snapshotId ?? null,
              attempt: null,
              fencingToken: null,
              type: "workflow.waiting",
              timestamp: now,
              payload: {
                workflowId,
                reason: decision.request.description,
                state: decision.kind,
              },
            }),
        });
      });
      return;
    }

    const record: StepRecord = {
      kind: decision.kind,
      next: decision.kind === "success" ? node.onSuccess : node.onFailure,
    };
    if (decision.kind === "failure") record.reason = decision.reason;
    if (decision.result !== undefined) record.result = decision.result;
    if (decision.contextUpdates !== undefined) record.contextUpdates = decision.contextUpdates;
    const merged = { ...context, ...definedOnly(decision.contextUpdates) };
    inTransaction(store.db, () => {
      // A produced decision — success OR failure — means the step ran to
      // completion; record it 'completed' so re-drive replays the stored
      // edge instead of re-executing (no second build job for a
      // compile-failed run). 'failed' is reserved for steps that never
      // produced a decision (crash, unsupported op, throw).
      store.updateWorkflowStep(scope, workflowId, stepRunId, {
        state: "completed",
        resultJson: canonicalJson(record),
        jobId: decision.jobId ?? null,
      });
      store.updateWorkflow(scope, workflowId, {
        currentNode: record.next,
        contextJson: canonicalJson(merged),
        updatedAt: now,
      });
    });
  }
}

/**
 * Answer a waiting step. waiting-input validates the supplied input against
 * the pending request record (a patchId must be a real in-scope patch based
 * on the CURRENT head); waiting-approval takes no input — the grant itself
 * arrives through the host approval channel, and resume re-checks it.
 */
export async function resumeWorkflow(
  deps: WorkflowDeps,
  options: {
    scope: Scope;
    workflowId: string;
    input?: unknown;
  },
): Promise<WorkflowStatus> {
  const { store, blobs, ctx } = deps;
  const { scope, workflowId, input } = options;
  requireCapability(ctx, "project.write");
  const row = workflowRow(store, scope, workflowId);
  const state = row["state"] as string;
  if (state !== "waiting-input" && state !== "waiting-approval") {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `workflow ${workflowId} is ${state}; resume is only valid from waiting-input/waiting-approval`,
    );
  }
  const spec = loadDefinitionFromCas(blobs, row["definition_hash"] as string);
  const pending = store.latestWaitingStep(scope, workflowId);
  if (pending === null) {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `workflow ${workflowId} is ${state} but no pending step run is recorded`,
    );
  }
  const pendingRecord = JSON.parse(pending["result_json"] as string) as {
    kind: string;
    request: PendingRequest;
  };
  const node = spec.nodes.find((n) => n.id === (pending["node_id"] as string));
  if (node === undefined) {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `pending step ${pending["step_run_id"]} references missing node`,
    );
  }

  if (state === "waiting-input") {
    const request = pendingRecord.request;
    const context = JSON.parse(row["context_json"] as string) as WorkflowContext;
    if (request.kind === "patch-proposal") {
      const patchId =
        typeof input === "object" && input !== null
          ? (input as { patchId?: unknown }).patchId
          : undefined;
      if (typeof patchId !== "string" || patchId.length === 0) {
        throw new WorkbenchError(
          ERROR_CODES.INVALID_REQUEST,
          `workflow ${workflowId} waits for {patchId} — a real in-scope patch based on the current head`,
        );
      }
      const patch = store.getPatch(scope, patchId);
      if (patch === null) {
        throw new WorkbenchError(
          ERROR_CODES.NOT_FOUND,
          `patch ${patchId} does not exist in scope — resume rejected`,
        );
      }
      const head = store.getProject(scope) as Row;
      const headId = head["head_snapshot_id"] as string;
      if ((patch["base_snapshot_id"] as string) !== headId) {
        throw new WorkbenchError(
          ERROR_CODES.STALE_BASE,
          `patch ${patchId} is based on ${patch["base_snapshot_id"]}, but the current head is ${headId}`,
        );
      }
      const merged: WorkflowContext = { ...context, patchId };
      const now = utcNowIso();
      inTransaction(store.db, () => {
        store.updateWorkflowStep(scope, workflowId, pending["step_run_id"] as string, {
          state: "completed",
          resultJson: canonicalJson({
            kind: "success",
            result: { patchId, suppliedBy: "host" },
            contextUpdates: { patchId },
            next: node.onSuccess,
          } satisfies StepRecord),
        });
        store.updateWorkflow(scope, workflowId, {
          currentNode: node.onSuccess,
          contextJson: canonicalJson(merged),
          state: "running",
          updatedAt: now,
        });
      });
    } else {
      // host-input: the host supplies an opaque JSON value as the result.
      if (input === undefined) {
        throw new WorkbenchError(
          ERROR_CODES.INVALID_REQUEST,
          `workflow ${workflowId} waits for host input — provide --input`,
        );
      }
      const now = utcNowIso();
      inTransaction(store.db, () => {
        store.updateWorkflowStep(scope, workflowId, pending["step_run_id"] as string, {
          state: "completed",
          resultJson: canonicalJson({
            kind: "success",
            result: input,
            next: node.onSuccess,
          } satisfies StepRecord),
        });
        store.updateWorkflow(scope, workflowId, {
          currentNode: node.onSuccess,
          state: "running",
          updatedAt: now,
        });
      });
    }
  } else {
    // waiting-approval: no input is accepted; the grant arrives through the
    // host approval channel. Resume just re-drives — the gate re-checks
    // head/policy/grant validity at this moment.
    if (input !== undefined) {
      throw new WorkbenchError(
        ERROR_CODES.INVALID_REQUEST,
        `workflow ${workflowId} waits for a host approval grant, not input; use 'latexwb approve'`,
      );
    }
    store.updateWorkflow(scope, workflowId, { state: "running", updatedAt: utcNowIso() });
  }

  await driveWorkflow(deps, scope, workflowId);
  return getWorkflowStatus(store, scope, workflowId);
}

/**
 * Terminal cancellation. Sets state `cancelled` (one-way) and cancels any
 * queued/running job this workflow owns — nothing applies patches or
 * publishes artifacts after cancellation.
 */
export function cancelWorkflow(
  deps: WorkflowDeps,
  options: { scope: Scope; workflowId: string },
): WorkflowStatus {
  const { store, ctx } = deps;
  const { scope, workflowId } = options;
  requireCapability(ctx, "project.write");
  const row = workflowRow(store, scope, workflowId);
  const state = row["state"] as string;
  if (["completed", "failed", "blocked", "cancelled"].includes(state)) {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `workflow ${workflowId} is already terminal (${state})`,
    );
  }
  inTransaction(store.db, () => {
    store.updateWorkflow(scope, workflowId, { state: "cancelled", updatedAt: utcNowIso() });
    store.failRunningSteps(
      scope,
      workflowId,
      canonicalJson({ kind: "failure", reason: "workflow cancelled by host" }),
    );
  });
  // Cancel in-flight jobs owned by this workflow's step runs.
  for (const step of store.listWorkflowSteps(scope, workflowId)) {
    const jobId = step["job_id"] as string | null;
    if (jobId === null) continue;
    try {
      deps.buildService.cancel(scope, jobId);
    } catch {
      // already finished/failed — nothing to cancel
    }
  }
  return getWorkflowStatus(store, scope, workflowId);
}

export function getWorkflowStatus(
  store: WorkbenchStore,
  scope: Scope,
  workflowId: string,
): WorkflowStatus {
  const row = workflowRow(store, scope, workflowId);
  const state = row["state"] as string;
  const pending =
    state === "waiting-input" || state === "waiting-approval"
      ? store.latestWaitingStep(scope, workflowId)
      : null;
  const steps = store.listWorkflowSteps(scope, workflowId).map((s) => ({
    stepRunId: s["step_run_id"] as string,
    nodeId: s["node_id"] as string,
    operationId: (s["operation_id"] as string | null) ?? null,
    state: s["state"] as string,
    jobId: (s["job_id"] as string | null) ?? null,
  }));
  return {
    workflowId,
    definitionId: row["definition_id"] as string,
    definitionHash: row["definition_hash"] as string,
    state: row["state"] as string,
    currentNode: row["current_node"] as string,
    context: JSON.parse(row["context_json"] as string) as WorkflowContext,
    budget: JSON.parse((row["budget_json"] as string) || "{}") as unknown,
    pendingRequest:
      pending === null
        ? null
        : ((JSON.parse(pending["result_json"] as string) as { request?: PendingRequest })
            .request ?? null),
    steps,
  };
}

export function listWorkflows(store: WorkbenchStore, scope: Scope): WorkflowStatus[] {
  return store
    .listWorkflows(scope)
    .map((r) => getWorkflowStatus(store, scope, r["workflow_id"] as string));
}
