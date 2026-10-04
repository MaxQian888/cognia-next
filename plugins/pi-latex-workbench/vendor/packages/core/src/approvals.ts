/**
 * Host-authenticated approvals (M2, WORKFLOW_ENGINE §4).
 *
 * Grants are created ONLY through this module, which the host (CLI in this
 * milestone, an authenticated HTTP channel later) calls after resolving the
 * operator identity itself. No LLM tool can create, mark, or consume an
 * approval — the eight-tool surface has no approve action, and nothing here
 * accepts an identity from model/tool parameters.
 *
 * Binding: an approval is valid only for (action, scope_digest=patchDigest,
 * base_snapshot_id, policy_id) and only until expires_at. A patch that
 * changes any of those needs a new grant.
 */
import { randomUUID } from "node:crypto";
import {
  addSecondsIso,
  canonicalJson,
  ERROR_CODES,
  utcNowIso,
  WorkbenchError,
} from "@latexwb/contracts";
import type { Row, Scope, WorkbenchStore } from "@latexwb/storage";
import { PRINCIPAL_ID_PATTERN } from "./context.ts";

export interface ApprovalGrant {
  approvalId: string;
  principalId: string;
  action: string;
  scopeDigest: string;
  baseSnapshotId: string;
  policyId: string;
  expiresAt: string;
  state: string;
}

/**
 * Grant an approval. `hostPrincipal` is the operator identity the HOST
 * resolved (CLI flag/env or authenticated session) — this function trusts
 * the caller to be the authenticated channel; it never reads identity from
 * patch content or tool parameters.
 */
export function grantApproval(options: {
  store: WorkbenchStore;
  scope: Scope;
  hostPrincipal: string;
  action: string;
  scopeDigest: string;
  baseSnapshotId: string;
  policyId: string;
  expiresInSeconds?: number | undefined;
  /** Host channel that produced the grant (audit only). */
  grantedVia?: "cli-host" | "pi-ui" | "host-authoring-mode";
}): ApprovalGrant {
  const { store, scope } = options;
  if (!PRINCIPAL_ID_PATTERN.test(options.hostPrincipal)) {
    throw new WorkbenchError(ERROR_CODES.INVALID_REQUEST, "host principal id is malformed");
  }
  const approvalId = `appr-${randomUUID()}`;
  const now = utcNowIso();
  const expiresAt = addSecondsIso(now, options.expiresInSeconds ?? 3600);
  const record = {
    kind: "approval",
    approvalId,
    principalId: options.hostPrincipal,
    action: options.action,
    scopeDigest: options.scopeDigest,
    baseSnapshotId: options.baseSnapshotId,
    policyId: options.policyId,
    expiresAt,
    grantedVia: options.grantedVia ?? "cli-host",
    note: "local host-authenticated grant; see docs/UNSUPPORTED.md for the boundary",
  };
  store.insertApproval(scope, {
    approvalId,
    principalId: options.hostPrincipal,
    action: options.action,
    scopeDigest: options.scopeDigest,
    baseSnapshotId: options.baseSnapshotId,
    policyId: options.policyId,
    expiresAt,
    recordJson: canonicalJson(record),
    createdAt: now,
  });
  return {
    approvalId,
    principalId: options.hostPrincipal,
    action: options.action,
    scopeDigest: options.scopeDigest,
    baseSnapshotId: options.baseSnapshotId,
    policyId: options.policyId,
    expiresAt,
    state: "granted",
  };
}

export function revokeApproval(options: {
  store: WorkbenchStore;
  scope: Scope;
  approvalId: string;
}): boolean {
  const { store, scope } = options;
  return store.transitionApproval(scope, options.approvalId, "granted", "revoked");
}

export function getApproval(store: WorkbenchStore, scope: Scope, approvalId: string): Row | null {
  return store.getApproval(scope, approvalId);
}

/**
 * Check whether a usable approval exists for a pending patch-like object.
 * Used by the workflow gate — it does NOT consume the grant; consumption is
 * part of the apply transaction.
 */
export function approvalStatus(options: {
  store: WorkbenchStore;
  scope: Scope;
  action: string;
  scopeDigest: string;
  baseSnapshotId: string;
  policyId: string;
}): { state: "granted" | "missing" | "expired-or-consumed"; approvalId: string | null } {
  const { store, scope } = options;
  const now = utcNowIso();
  store.expireApprovals(scope, now);
  const usable = store.findUsableApproval(
    scope,
    options.action,
    options.scopeDigest,
    options.baseSnapshotId,
    options.policyId,
    now,
  );
  if (usable !== null) {
    return { state: "granted", approvalId: usable["approval_id"] as string };
  }
  return { state: "missing", approvalId: null };
}
