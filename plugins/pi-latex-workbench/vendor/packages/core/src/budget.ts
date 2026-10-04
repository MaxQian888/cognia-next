/**
 * Repair budget (M2, WORKFLOW_ENGINE §5): persisted per workflow in
 * workflows.budget_json so a new Pi session cannot reset it, and nothing a
 * model says can decrement it — only this module writes counters.
 *
 * Limits come from the workflow definition (repair: maxPatchApplications=3,
 * maxSameCauseAttempts=2). causeId is the normalized diagnostic fingerprint
 * from M1 — error family + source anchor + context token, NOT a whole-log
 * hash.
 */
import { canonicalJson, ERROR_CODES, WorkbenchError } from "@latexwb/contracts";
import { inTransaction, type Scope, type WorkbenchStore } from "@latexwb/storage";

export interface BudgetState {
  patchApplications: number;
  causeAttempts: Record<string, number>;
}

export interface BudgetLimits {
  maxPatchApplications: number;
  maxSameCauseAttempts: number;
}

export function readBudget(store: WorkbenchStore, scope: Scope, workflowId: string): BudgetState {
  const row = store.getWorkflow(scope, workflowId);
  if (row === null) {
    throw new WorkbenchError(ERROR_CODES.NOT_FOUND, `workflow ${workflowId} not found`);
  }
  const raw = JSON.parse((row["budget_json"] as string) || "{}") as Partial<BudgetState>;
  return {
    patchApplications: raw.patchApplications ?? 0,
    causeAttempts: raw.causeAttempts ?? {},
  };
}

function writeBudget(
  store: WorkbenchStore,
  scope: Scope,
  workflowId: string,
  budget: BudgetState,
  updatedAt: string,
): void {
  store.updateWorkflow(scope, workflowId, { budgetJson: canonicalJson(budget), updatedAt });
}

/**
 * Would one more apply/cause-attempt exceed the budget? Returns the reason
 * string when blocked; `null` when the attempt is allowed. Read-only —
 * counters move only via recordApply/recordCauseAttempt.
 */
export function checkBudget(
  store: WorkbenchStore,
  scope: Scope,
  workflowId: string,
  causeId: string | null,
  limits: BudgetLimits,
): string | null {
  const b = readBudget(store, scope, workflowId);
  if (b.patchApplications >= limits.maxPatchApplications) {
    return `patch application budget exhausted: ${b.patchApplications}/${limits.maxPatchApplications}`;
  }
  if (causeId !== null && (b.causeAttempts[causeId] ?? 0) >= limits.maxSameCauseAttempts) {
    return `same-cause attempt budget exhausted for ${causeId}: ${b.causeAttempts[causeId]}/${limits.maxSameCauseAttempts}`;
  }
  return null;
}

/** A patch was actually applied — count it. */
export function recordApply(
  store: WorkbenchStore,
  scope: Scope,
  workflowId: string,
  updatedAt: string,
): void {
  // BEGIN IMMEDIATE holds the write lock for the whole read-modify-write —
  // a concurrent budget update on another connection cannot interleave.
  inTransaction(store.db, () => {
    const b = readBudget(store, scope, workflowId);
    b.patchApplications += 1;
    writeBudget(store, scope, workflowId, b, updatedAt);
  });
}

/** A repair attempt against this normalized cause reached the apply stage. */
export function recordCauseAttempt(
  store: WorkbenchStore,
  scope: Scope,
  workflowId: string,
  causeId: string,
  updatedAt: string,
): void {
  inTransaction(store.db, () => {
    const b = readBudget(store, scope, workflowId);
    b.causeAttempts[causeId] = (b.causeAttempts[causeId] ?? 0) + 1;
    writeBudget(store, scope, workflowId, b, updatedAt);
  });
}
