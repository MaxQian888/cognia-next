/**
 * Scoped repositories. Every query carries (workspaceId, projectId); there is
 * deliberately no "get by id globally" API, so cross-scope objects surface as
 * nonexistent rather than leaking existence (API_CONTRACT §6).
 */
import type { DatabaseSync } from "node:sqlite";
import { WorkbenchError, ERROR_CODES, formatErrors, validatorFor } from "@latexwb/contracts";

export interface Scope {
  workspaceId: string;
  projectId: string;
}

export type Row = Record<string, unknown>;

export interface NewSnapshot {
  snapshotId: string;
  parentSnapshotId: string | null;
  treeHash: string;
  manifestJson: string;
  createdAt: string;
}

export interface NewSnapshotFile {
  path: string;
  blobHash: string;
  sizeBytes: number;
  role: string;
}

export interface NewJob {
  jobId: string;
  principalId: string;
  action: string;
  inputDigest: string;
  inputJson: string;
  state?: string;
  snapshotId?: string | null;
  targetId?: string | null;
  attempt?: number;
  parentJobId?: string | null;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  fencingToken?: number;
  createdAt: string;
}

export interface NewArtifact {
  artifactId: string;
  snapshotId: string;
  jobId: string;
  kind: string;
  blobHash: string;
  sizeBytes: number;
  mediaType: string;
  manifestJson: string;
  targetId?: string | null;
  createdAt: string;
}

export interface NewPatch {
  patchId: string;
  baseSnapshotId: string;
  patchDigest: string;
  operationsJson: string;
  protectedChangesJson: string;
  state?: string;
  resultSnapshotId?: string | null;
  createdAt: string;
}

export interface NewIdempotencyRecord {
  principalId: string;
  idempotencyKey: string;
  action: string;
  inputDigest: string;
  state: string;
  resultJson: string | null;
  createdAt: string;
}

export interface NewEvidence {
  evidenceId: string;
  snapshotId: string;
  kind: string;
  sourceLocator: string;
  contentHash: string;
  accessStatus: string;
  recordJson: string;
  createdAt: string;
}

export class WorkbenchStore {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  // ---------- projects ----------
  createProject(scope: Scope, configJson: string, createdAt: string, hostRoot: string | null = null): void {
    this.db
      .prepare(
        "INSERT INTO projects(workspace_id,project_id,config_json,host_root,created_at) VALUES(?,?,?,?,?)",
      )
      .run(scope.workspaceId, scope.projectId, configJson, hostRoot, createdAt);
  }

  getProject(scope: Scope): Row | null {
    const row = this.db
      .prepare("SELECT * FROM projects WHERE workspace_id=? AND project_id=?")
      .get(scope.workspaceId, scope.projectId);
    return (row as Row | undefined) ?? null;
  }

  updateProjectConfigJson(scope: Scope, configJson: string): void {
    this.db
      .prepare(
        "UPDATE projects SET config_json=? WHERE workspace_id=? AND project_id=?",
      )
      .run(configJson, scope.workspaceId, scope.projectId);
  }

  /**
   * Host-owned import root — set at import or backfilled for pre-0003
   * projects. Never sourced from ProjectConfig: project content must not
   * be able to widen its own host-write surface.
   */
  setProjectHostRoot(scope: Scope, hostRoot: string | null): void {
    this.db
      .prepare(
        "UPDATE projects SET host_root=? WHERE workspace_id=? AND project_id=?",
      )
      .run(hostRoot, scope.workspaceId, scope.projectId);
  }

  /** CAS head update: succeeds only when current revision matches. */
  updateHeadSnapshot(scope: Scope, snapshotId: string, expectedRevision: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE projects SET head_snapshot_id=?, revision=revision+1
         WHERE workspace_id=? AND project_id=? AND revision=?`,
      )
      .run(snapshotId, scope.workspaceId, scope.projectId, expectedRevision);
    return result.changes === 1;
  }

  // ---------- snapshots ----------
  insertSnapshot(scope: Scope, snapshot: NewSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO snapshots(workspace_id,project_id,snapshot_id,parent_snapshot_id,tree_hash,manifest_json,created_at)
         VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        scope.workspaceId,
        scope.projectId,
        snapshot.snapshotId,
        snapshot.parentSnapshotId,
        snapshot.treeHash,
        snapshot.manifestJson,
        snapshot.createdAt,
      );
  }

  getSnapshot(scope: Scope, snapshotId: string): Row | null {
    const row = this.db
      .prepare(
        "SELECT * FROM snapshots WHERE workspace_id=? AND project_id=? AND snapshot_id=?",
      )
      .get(scope.workspaceId, scope.projectId, snapshotId);
    return (row as Row | undefined) ?? null;
  }

  /** Earliest snapshot of the project with this tree hash (content identity). */
  earliestSnapshotWithTree(scope: Scope, treeHash: string): Row | null {
    const row = this.db
      .prepare(
        `SELECT * FROM snapshots WHERE workspace_id=? AND project_id=? AND tree_hash=?
         ORDER BY created_at, snapshot_id LIMIT 1`,
      )
      .get(scope.workspaceId, scope.projectId, treeHash);
    return (row as Row | undefined) ?? null;
  }

  insertSnapshotFiles(scope: Scope, snapshotId: string, files: NewSnapshotFile[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO snapshot_files(workspace_id,project_id,snapshot_id,path,blob_hash,size_bytes,role)
       VALUES(?,?,?,?,?,?,?)`,
    );
    for (const f of files) {
      stmt.run(scope.workspaceId, scope.projectId, snapshotId, f.path, f.blobHash, f.sizeBytes, f.role);
    }
  }

  listSnapshotFiles(scope: Scope, snapshotId: string): Row[] {
    return this.db
      .prepare(
        `SELECT * FROM snapshot_files WHERE workspace_id=? AND project_id=? AND snapshot_id=?
         ORDER BY path`,
      )
      .all(scope.workspaceId, scope.projectId, snapshotId) as Row[];
  }

  // ---------- targets ----------
  putTarget(scope: Scope, targetId: string, configJson: string, configHash: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO targets(workspace_id,project_id,target_id,config_json,config_hash)
         VALUES(?,?,?,?,?)`,
      )
      .run(scope.workspaceId, scope.projectId, targetId, configJson, configHash);
  }

  getTarget(scope: Scope, targetId: string): Row | null {
    const row = this.db
      .prepare(
        "SELECT * FROM targets WHERE workspace_id=? AND project_id=? AND target_id=?",
      )
      .get(scope.workspaceId, scope.projectId, targetId);
    return (row as Row | undefined) ?? null;
  }

  listTargets(scope: Scope): Row[] {
    return this.db
      .prepare("SELECT * FROM targets WHERE workspace_id=? AND project_id=? ORDER BY target_id")
      .all(scope.workspaceId, scope.projectId) as Row[];
  }

  // ---------- jobs ----------
  insertJob(scope: Scope, job: NewJob): void {
    this.db
      .prepare(
        `INSERT INTO jobs(workspace_id,project_id,job_id,principal_id,snapshot_id,target_id,
           state,action,input_digest,input_json,attempt,parent_job_id,lease_owner,lease_expires_at,
           fencing_token,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        scope.workspaceId,
        scope.projectId,
        job.jobId,
        job.principalId,
        job.snapshotId ?? null,
        job.targetId ?? null,
        job.state ?? "queued",
        job.action,
        job.inputDigest,
        job.inputJson,
        job.attempt ?? 1,
        job.parentJobId ?? null,
        job.leaseOwner ?? null,
        job.leaseExpiresAt ?? null,
        job.fencingToken ?? 0,
        job.createdAt,
      );
  }

  getJob(scope: Scope, jobId: string): Row | null {
    const row = this.db
      .prepare("SELECT * FROM jobs WHERE workspace_id=? AND project_id=? AND job_id=?")
      .get(scope.workspaceId, scope.projectId, jobId);
    return (row as Row | undefined) ?? null;
  }

  listJobs(scope: Scope, options: { limit?: number } = {}): Row[] {
    return this.db
      .prepare(
        `SELECT * FROM jobs WHERE workspace_id=? AND project_id=?
         ORDER BY created_at DESC, job_id LIMIT ?`,
      )
      .all(scope.workspaceId, scope.projectId, options.limit ?? 200) as Row[];
  }

  /** Oldest queued job for a worker claim; call inside inTransaction. */
  nextQueuedJob(scope: Scope): Row | null {
    const row = this.db
      .prepare(
        `SELECT * FROM jobs WHERE workspace_id=? AND project_id=? AND state='queued'
         ORDER BY created_at, job_id LIMIT 1`,
      )
      .get(scope.workspaceId, scope.projectId);
    return (row as Row | undefined) ?? null;
  }

  /**
   * Atomic queued→running transition with lease + fencing increment.
   * Returns the new fencing token, or null when the CAS lost (another worker
   * or a cancel won the transition). Call inside inTransaction.
   */
  claimJob(
    scope: Scope,
    jobId: string,
    workerId: string,
    leaseExpiresAt: string,
  ): number | null {
    const result = this.db
      .prepare(
        `UPDATE jobs SET state='running', lease_owner=?, lease_expires_at=?,
           fencing_token=fencing_token+1
         WHERE workspace_id=? AND project_id=? AND job_id=? AND state='queued'`,
      )
      .run(workerId, leaseExpiresAt, scope.workspaceId, scope.projectId, jobId);
    if (result.changes !== 1) return null;
    const row = this.getJob(scope, jobId);
    return (row?.["fencing_token"] as number) ?? null;
  }

  /** Extend a running job's lease; false when fencing/state no longer match. */
  heartbeatJob(scope: Scope, jobId: string, fencingToken: number, leaseExpiresAt: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE jobs SET lease_expires_at=?
         WHERE workspace_id=? AND project_id=? AND job_id=?
           AND state='running' AND fencing_token=?`,
      )
      .run(leaseExpiresAt, scope.workspaceId, scope.projectId, jobId, fencingToken);
    return result.changes === 1;
  }

  /**
   * Terminal transition guarded by fencing token and expected prior states.
   * `expectedStates` encodes the legal sources for the requested outcome.
   * Returns false for any late/stale finalize — the row is unchanged then.
   */
  finalizeJob(
    scope: Scope,
    jobId: string,
    fencingToken: number,
    expectedStates: string[],
    update: {
      state: string;
      resultJson?: string | null;
      errorCode?: string | null;
      finishedAt: string;
    },
  ): boolean {
    const placeholders = expectedStates.map(() => "?").join(",");
    const result = this.db
      .prepare(
        `UPDATE jobs SET state=?, result_json=?, error_code=?, finished_at=?
         WHERE workspace_id=? AND project_id=? AND job_id=?
           AND fencing_token=? AND state IN (${placeholders})`,
      )
      .run(
        update.state,
        update.resultJson ?? null,
        update.errorCode ?? null,
        update.finishedAt,
        scope.workspaceId,
        scope.projectId,
        jobId,
        fencingToken,
        ...expectedStates,
      );
    return result.changes === 1;
  }

  /** running|queued → cancel-requested; queued → cancelled. Inside tx. */
  requestCancelJob(scope: Scope, jobId: string, cancelAt: string, finishedAt: string): string {
    const job = this.getJob(scope, jobId);
    if (job === null) return "not-found";
    const state = job["state"] as string;
    if (["succeeded", "failed", "cancelled", "timed-out", "lost"].includes(state)) {
      return "already-terminal";
    }
    if (state === "cancel-requested") return "cancel-requested";
    if (state === "queued") {
      // A queued job has no worker to signal: straight to terminal cancelled.
      this.db
        .prepare(
          `UPDATE jobs SET state='cancelled', cancel_requested_at=?, finished_at=?
           WHERE workspace_id=? AND project_id=? AND job_id=? AND state='queued'`,
        )
        .run(cancelAt, finishedAt, scope.workspaceId, scope.projectId, jobId);
      return "cancelled";
    }
    this.db
      .prepare(
        `UPDATE jobs SET state='cancel-requested', cancel_requested_at=?
         WHERE workspace_id=? AND project_id=? AND job_id=? AND state='running'`,
      )
      .run(cancelAt, scope.workspaceId, scope.projectId, jobId);
    return "cancel-requested";
  }

  /** Running/cancel-requested jobs whose lease expired before `nowIso`. */
  listExpiredLeases(scope: Scope, nowIso: string): Row[] {
    return this.db
      .prepare(
        `SELECT * FROM jobs WHERE workspace_id=? AND project_id=?
           AND state IN ('running','cancel-requested')
           AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`,
      )
      .all(scope.workspaceId, scope.projectId, nowIso) as Row[];
  }

  /** Terminal transition to 'lost'; fencing bump invalidates the dead worker. */
  markJobLost(scope: Scope, jobId: string, finishedAt: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE jobs SET state='lost', fencing_token=fencing_token+1, finished_at=?
         WHERE workspace_id=? AND project_id=? AND job_id=?
           AND state IN ('running','cancel-requested')`,
      )
      .run(finishedAt, scope.workspaceId, scope.projectId, jobId);
    return result.changes === 1;
  }

  /** Latest succeeded job for an input digest — build-cache lookup. */
  latestSucceededByDigest(scope: Scope, action: string, inputDigest: string): Row | null {
    const row = this.db
      .prepare(
        `SELECT * FROM jobs WHERE workspace_id=? AND project_id=?
           AND action=? AND input_digest=? AND state='succeeded'
         ORDER BY finished_at DESC, job_id LIMIT 1`,
      )
      .get(scope.workspaceId, scope.projectId, action, inputDigest);
    return (row as Row | undefined) ?? null;
  }

  listArtifactsByJob(scope: Scope, jobId: string): Row[] {
    return this.db
      .prepare(
        `SELECT * FROM artifacts WHERE workspace_id=? AND project_id=? AND job_id=?
         ORDER BY artifact_id`,
      )
      .all(scope.workspaceId, scope.projectId, jobId) as Row[];
  }

  // ---------- artifacts ----------
  insertArtifact(scope: Scope, artifact: NewArtifact): void {
    this.db
      .prepare(
        `INSERT INTO artifacts(workspace_id,project_id,artifact_id,snapshot_id,target_id,job_id,
           kind,blob_hash,size_bytes,media_type,manifest_json,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        scope.workspaceId,
        scope.projectId,
        artifact.artifactId,
        artifact.snapshotId,
        artifact.targetId ?? null,
        artifact.jobId,
        artifact.kind,
        artifact.blobHash,
        artifact.sizeBytes,
        artifact.mediaType,
        artifact.manifestJson,
        artifact.createdAt,
      );
  }

  getArtifact(scope: Scope, artifactId: string): Row | null {
    const row = this.db
      .prepare("SELECT * FROM artifacts WHERE workspace_id=? AND project_id=? AND artifact_id=?")
      .get(scope.workspaceId, scope.projectId, artifactId);
    return (row as Row | undefined) ?? null;
  }

  listArtifactsBySnapshot(scope: Scope, snapshotId: string): Row[] {
    return this.db
      .prepare(
        `SELECT * FROM artifacts WHERE workspace_id=? AND project_id=? AND snapshot_id=?
         ORDER BY created_at, artifact_id`,
      )
      .all(scope.workspaceId, scope.projectId, snapshotId) as Row[];
  }

  // ---------- evidence ----------
  /**
   * Evidence records are immutable, digest-bound observations. `content_hash`
   * is the SHA-256 of the bytes actually observed (blob in CAS); the caller
   * writes the blob first. A row is written once — there is no update API.
   */
  insertEvidence(scope: Scope, evidence: NewEvidence): void {
    this.db
      .prepare(
        `INSERT INTO evidence(workspace_id,project_id,evidence_id,snapshot_id,kind,
           source_locator,content_hash,access_status,record_json,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        scope.workspaceId,
        scope.projectId,
        evidence.evidenceId,
        evidence.snapshotId,
        evidence.kind,
        evidence.sourceLocator,
        evidence.contentHash,
        evidence.accessStatus,
        evidence.recordJson,
        evidence.createdAt,
      );
  }

  getEvidence(scope: Scope, evidenceId: string): Row | null {
    const row = this.db
      .prepare("SELECT * FROM evidence WHERE workspace_id=? AND project_id=? AND evidence_id=?")
      .get(scope.workspaceId, scope.projectId, evidenceId);
    return (row as Row | undefined) ?? null;
  }

  listEvidence(scope: Scope, filter: { snapshotId?: string; kind?: string } = {}): Row[] {
    let sql =
      "SELECT * FROM evidence WHERE workspace_id=? AND project_id=?";
    const args: unknown[] = [scope.workspaceId, scope.projectId];
    if (filter.snapshotId !== undefined) {
      sql += " AND snapshot_id=?";
      args.push(filter.snapshotId);
    }
    if (filter.kind !== undefined) {
      sql += " AND kind=?";
      args.push(filter.kind);
    }
    sql += " ORDER BY created_at, evidence_id";
    return this.db.prepare(sql).all(...(args as string[])) as Row[];
  }

  // ---------- patches ----------
  insertPatch(scope: Scope, patch: NewPatch): void {
    this.db
      .prepare(
        `INSERT INTO patches(workspace_id,project_id,patch_id,base_snapshot_id,result_snapshot_id,
           patch_digest,state,operations_json,protected_changes_json,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        scope.workspaceId,
        scope.projectId,
        patch.patchId,
        patch.baseSnapshotId,
        patch.resultSnapshotId ?? null,
        patch.patchDigest,
        patch.state ?? "proposed",
        patch.operationsJson,
        patch.protectedChangesJson,
        patch.createdAt,
      );
  }

  getPatch(scope: Scope, patchId: string): Row | null {
    const row = this.db
      .prepare("SELECT * FROM patches WHERE workspace_id=? AND project_id=? AND patch_id=?")
      .get(scope.workspaceId, scope.projectId, patchId);
    return (row as Row | undefined) ?? null;
  }

  /** The applied patch that produced `snapshotId`, if any. */
  findPatchByResultSnapshot(scope: Scope, snapshotId: string): Row | null {
    const row = this.db
      .prepare(
        `SELECT * FROM patches WHERE workspace_id=? AND project_id=? AND result_snapshot_id=?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(scope.workspaceId, scope.projectId, snapshotId);
    return (row as Row | undefined) ?? null;
  }

  /** Patches of a project, newest first; optionally only those in `state`. */
  listPatches(scope: Scope, filter: { state?: string; limit?: number } = {}): Row[] {
    const limit = Math.max(1, Math.min(filter.limit ?? 50, 500));
    if (filter.state !== undefined) {
      return this.db
        .prepare(
          `SELECT * FROM patches WHERE workspace_id=? AND project_id=? AND state=?
           ORDER BY created_at DESC, patch_id DESC LIMIT ?`,
        )
        .all(scope.workspaceId, scope.projectId, filter.state, limit) as Row[];
    }
    return this.db
      .prepare(
        `SELECT * FROM patches WHERE workspace_id=? AND project_id=?
         ORDER BY created_at DESC, patch_id DESC LIMIT ?`,
      )
      .all(scope.workspaceId, scope.projectId, limit) as Row[];
  }

  updatePatchState(scope: Scope, patchId: string, state: string, resultSnapshotId?: string): void {
    this.db
      .prepare(
        `UPDATE patches SET state=?, result_snapshot_id=COALESCE(?,result_snapshot_id)
         WHERE workspace_id=? AND project_id=? AND patch_id=?`,
      )
      .run(state, resultSnapshotId ?? null, scope.workspaceId, scope.projectId, patchId);
  }

  /** CAS on patch state — apply must not clobber a concurrent terminal change. */
  updatePatchStateCas(
    scope: Scope,
    patchId: string,
    expectedStates: string[],
    state: string,
    resultSnapshotId?: string | null,
  ): boolean {
    const marks = expectedStates.map(() => "?").join(",");
    const r = this.db
      .prepare(
        `UPDATE patches SET state=?, result_snapshot_id=COALESCE(?,result_snapshot_id)
         WHERE workspace_id=? AND project_id=? AND patch_id=? AND state IN(${marks})`,
      )
      .run(state, resultSnapshotId ?? null, scope.workspaceId, scope.projectId, patchId, ...expectedStates);
    return r.changes > 0;
  }

  // ---------- approvals ----------
  insertApproval(scope: Scope, approval: {
    approvalId: string;
    principalId: string;
    action: string;
    scopeDigest: string;
    baseSnapshotId: string;
    policyId: string;
    expiresAt: string;
    recordJson: string;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO approvals(workspace_id,project_id,approval_id,principal_id,action,
           scope_digest,base_snapshot_id,policy_id,expires_at,state,record_json,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,'granted',?,?)`,
      )
      .run(
        scope.workspaceId, scope.projectId, approval.approvalId, approval.principalId,
        approval.action, approval.scopeDigest, approval.baseSnapshotId, approval.policyId,
        approval.expiresAt, approval.recordJson, approval.createdAt,
      );
  }

  getApproval(scope: Scope, approvalId: string): Row | null {
    const row = this.db
      .prepare("SELECT * FROM approvals WHERE workspace_id=? AND project_id=? AND approval_id=?")
      .get(scope.workspaceId, scope.projectId, approvalId);
    return (row as Row | undefined) ?? null;
  }

  /** Granted, unexpired approval matching action+digest+base+policy, or null. */
  findUsableApproval(
    scope: Scope,
    action: string,
    scopeDigest: string,
    baseSnapshotId: string,
    policyId: string,
    nowIso: string,
  ): Row | null {
    const row = this.db
      .prepare(
        `SELECT * FROM approvals
         WHERE workspace_id=? AND project_id=? AND action=? AND scope_digest=?
           AND base_snapshot_id=? AND policy_id=? AND state='granted' AND expires_at>?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(scope.workspaceId, scope.projectId, action, scopeDigest, baseSnapshotId, policyId, nowIso);
    return (row as Row | undefined) ?? null;
  }

  listApprovals(scope: Scope): Row[] {
    return this.db
      .prepare(
        `SELECT * FROM approvals WHERE workspace_id=? AND project_id=?
         ORDER BY created_at, approval_id`,
      )
      .all(scope.workspaceId, scope.projectId) as Row[];
  }

  /** granted→consumed/revoked CAS; returns false when the state already moved. */
  transitionApproval(scope: Scope, approvalId: string, from: string, to: string): boolean {
    const r = this.db
      .prepare(
        `UPDATE approvals SET state=? WHERE workspace_id=? AND project_id=?
         AND approval_id=? AND state=?`,
      )
      .run(to, scope.workspaceId, scope.projectId, approvalId, from);
    return r.changes > 0;
  }

  /** Lazily expire grants past their deadline; returns expired ids. */
  expireApprovals(scope: Scope, nowIso: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT approval_id FROM approvals WHERE workspace_id=? AND project_id=?
         AND state='granted' AND expires_at<=?`,
      )
      .all(scope.workspaceId, scope.projectId, nowIso) as Row[];
    for (const r of rows) {
      this.transitionApproval(scope, r["approval_id"] as string, "granted", "expired");
    }
    return rows.map((r) => r["approval_id"] as string);
  }

  // ---------- workflows / workflow_steps ----------
  insertWorkflow(scope: Scope, wf: {
    workflowId: string;
    definitionId: string;
    definitionVersion: number;
    definitionHash: string;
    currentNode: string;
    state: string;
    contextJson: string;
    budgetJson: string;
    createdAt: string;
    updatedAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO workflows(workspace_id,project_id,workflow_id,definition_id,definition_version,
           definition_hash,current_node,state,context_json,budget_json,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        scope.workspaceId, scope.projectId, wf.workflowId, wf.definitionId, wf.definitionVersion,
        wf.definitionHash,
        wf.currentNode, wf.state, wf.contextJson, wf.budgetJson, wf.createdAt, wf.updatedAt,
      );
  }

  getWorkflow(scope: Scope, workflowId: string): Row | null {
    const row = this.db
      .prepare("SELECT * FROM workflows WHERE workspace_id=? AND project_id=? AND workflow_id=?")
      .get(scope.workspaceId, scope.projectId, workflowId);
    return (row as Row | undefined) ?? null;
  }

  updateWorkflow(scope: Scope, workflowId: string, fields: {
    currentNode?: string;
    state?: string;
    contextJson?: string;
    budgetJson?: string;
    updatedAt: string;
  }): void {
    this.db
      .prepare(
        `UPDATE workflows SET current_node=COALESCE(?,current_node), state=COALESCE(?,state),
           context_json=COALESCE(?,context_json), budget_json=COALESCE(?,budget_json), updated_at=?
         WHERE workspace_id=? AND project_id=? AND workflow_id=?`,
      )
      .run(
        fields.currentNode ?? null, fields.state ?? null, fields.contextJson ?? null,
        fields.budgetJson ?? null, fields.updatedAt,
        scope.workspaceId, scope.projectId, workflowId,
      );
  }

  insertWorkflowStep(scope: Scope, step: {
    workflowId: string;
    stepRunId: string;
    nodeId: string;
    inputDigest: string;
    state: string;
    operationId?: string | null;
    operationVersion?: number | null;
    resultJson?: string | null;
    jobId?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO workflow_steps(workspace_id,project_id,workflow_id,step_run_id,node_id,
           input_digest,state,result_json,job_id,operation_id,operation_version)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        scope.workspaceId, scope.projectId, step.workflowId, step.stepRunId, step.nodeId,
        step.inputDigest, step.state, step.resultJson ?? null, step.jobId ?? null,
        step.operationId ?? null, step.operationVersion ?? null,
      );
  }

  /**
   * The latest step run for a node+input — used for completed-run reuse on
   * resume and for finding the pending waiting-* run that resume answers.
   */
  findWorkflowStepRun(
    scope: Scope,
    workflowId: string,
    nodeId: string,
    inputDigest: string,
    state?: string,
  ): Row | null {
    const row = this.db
      .prepare(
        `SELECT * FROM workflow_steps WHERE workspace_id=? AND project_id=?
         AND workflow_id=? AND node_id=? AND input_digest=?
         ${state === undefined ? "" : "AND state=?"} ORDER BY rowid DESC LIMIT 1`,
      )
      .get(
        ...(state === undefined
          ? [scope.workspaceId, scope.projectId, workflowId, nodeId, inputDigest]
          : [scope.workspaceId, scope.projectId, workflowId, nodeId, inputDigest, state]),
      );
    return (row as Row | undefined) ?? null;
  }

  /** The most recent step run of the workflow still in a waiting-* state. */
  latestWaitingStep(scope: Scope, workflowId: string): Row | null {
    const row = this.db
      .prepare(
        `SELECT * FROM workflow_steps WHERE workspace_id=? AND project_id=?
         AND workflow_id=? AND state IN('waiting-input','waiting-approval')
         ORDER BY rowid DESC LIMIT 1`,
      )
      .get(scope.workspaceId, scope.projectId, workflowId);
    return (row as Row | undefined) ?? null;
  }

  /** Mark stale 'running' step runs as failed after an interrupted drive. */
  failRunningSteps(scope: Scope, workflowId: string, resultJson: string): number {
    const res = this.db
      .prepare(
        `UPDATE workflow_steps SET state='failed', result_json=?
         WHERE workspace_id=? AND project_id=? AND workflow_id=? AND state='running'`,
      )
      .run(resultJson, scope.workspaceId, scope.projectId, workflowId);
    return Number(res.changes);
  }

  getWorkflowStep(scope: Scope, workflowId: string, stepRunId: string): Row | null {
    const row = this.db
      .prepare(
        `SELECT * FROM workflow_steps WHERE workspace_id=? AND project_id=?
         AND workflow_id=? AND step_run_id=?`,
      )
      .get(scope.workspaceId, scope.projectId, workflowId, stepRunId);
    return (row as Row | undefined) ?? null;
  }

  listWorkflowSteps(scope: Scope, workflowId: string): Row[] {
    return this.db
      .prepare(
        `SELECT * FROM workflow_steps WHERE workspace_id=? AND project_id=? AND workflow_id=?
         ORDER BY rowid`,
      )
      .all(scope.workspaceId, scope.projectId, workflowId) as Row[];
  }

  /** Workspace-level lookup so `workflow status <id>` works without
   * knowing the project up front. Still workspace-scoped. */
  findWorkflowProject(workspaceId: string, workflowId: string): string | null {
    const row = this.db
      .prepare(
        "SELECT project_id FROM workflows WHERE workspace_id=? AND workflow_id=?",
      )
      .get(workspaceId, workflowId);
    return ((row as Row | undefined)?.["project_id"] as string | undefined) ?? null;
  }

  listWorkflows(scope: Scope): Row[] {
    return this.db
      .prepare(
        `SELECT * FROM workflows WHERE workspace_id=? AND project_id=? ORDER BY created_at`,
      )
      .all(scope.workspaceId, scope.projectId) as Row[];
  }

  updateWorkflowStep(scope: Scope, workflowId: string, stepRunId: string, fields: {
    state?: string;
    resultJson?: string | null;
    jobId?: string | null;
  }): void {
    this.db
      .prepare(
        `UPDATE workflow_steps SET state=COALESCE(?,state), result_json=COALESCE(?,result_json),
           job_id=COALESCE(?,job_id)
         WHERE workspace_id=? AND project_id=? AND workflow_id=? AND step_run_id=?`,
      )
      .run(
        fields.state ?? null, fields.resultJson ?? null, fields.jobId ?? null,
        scope.workspaceId, scope.projectId, workflowId, stepRunId,
      );
  }

  // ---------- materialization_journals ----------
  insertJournal(scope: Scope, j: {
    journalId: string;
    fromSnapshotId: string;
    toSnapshotId: string;
    state: string;
    itemsJson: string;
    detailJson?: string | null;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO materialization_journals(workspace_id,project_id,journal_id,
           from_snapshot_id,to_snapshot_id,state,items_json,detail_json,created_at)
         VALUES(?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        scope.workspaceId, scope.projectId, j.journalId, j.fromSnapshotId,
        j.toSnapshotId, j.state, j.itemsJson, j.detailJson ?? null, j.createdAt,
      );
  }

  getJournal(scope: Scope, journalId: string): Row | null {
    const row = this.db
      .prepare(
        `SELECT * FROM materialization_journals WHERE workspace_id=? AND project_id=?
         AND journal_id=?`,
      )
      .get(scope.workspaceId, scope.projectId, journalId);
    return (row as Row | undefined) ?? null;
  }

  updateJournalState(scope: Scope, journalId: string, state: string, detailJson?: string | null): void {
    this.db
      .prepare(
        `UPDATE materialization_journals SET state=?,
           detail_json=COALESCE(?,detail_json)
         WHERE workspace_id=? AND project_id=? AND journal_id=?`,
      )
      .run(state, detailJson ?? null, scope.workspaceId, scope.projectId, journalId);
  }

  /** Latest journal for a project — recovery reads this on startup. */
  latestJournal(scope: Scope): Row | null {
    const row = this.db
      .prepare(
        `SELECT * FROM materialization_journals WHERE workspace_id=? AND project_id=?
         ORDER BY created_at DESC, journal_id DESC LIMIT 1`,
      )
      .get(scope.workspaceId, scope.projectId);
    return (row as Row | undefined) ?? null;
  }

  /** Latest COMPLETED journal — the baseline for external-edit detection. */
  latestCompletedJournal(scope: Scope): Row | null {
    const row = this.db
      .prepare(
        `SELECT * FROM materialization_journals WHERE workspace_id=? AND project_id=?
           AND state='completed'
         ORDER BY created_at DESC, journal_id DESC LIMIT 1`,
      )
      .get(scope.workspaceId, scope.projectId);
    return (row as Row | undefined) ?? null;
  }

  /** Journals in a non-terminal state (prepared/applying/rolling-back). */
  listUnfinishedJournals(scope: Scope): Row[] {
    return this.db
      .prepare(
        `SELECT * FROM materialization_journals WHERE workspace_id=? AND project_id=?
           AND state IN ('prepared','applying','rolling-back')
         ORDER BY created_at, journal_id`,
      )
      .all(scope.workspaceId, scope.projectId) as Row[];
  }

  // ---------- checks / reviews ----------
  insertCheck(scope: Scope, c: {
    checkRunId: string;
    artifactId: string;
    snapshotId: string;
    checkId: string;
    checkVersion: string;
    inputDigest: string;
    status: string;
    resultJson: string;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO checks(workspace_id,project_id,check_run_id,artifact_id,snapshot_id,
           check_id,check_version,input_digest,status,result_json,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        scope.workspaceId, scope.projectId, c.checkRunId, c.artifactId, c.snapshotId,
        c.checkId, c.checkVersion, c.inputDigest, c.status, c.resultJson, c.createdAt,
      );
  }

  listChecks(scope: Scope, artifactId: string): Row[] {
    return this.db
      .prepare(
        `SELECT * FROM checks WHERE workspace_id=? AND project_id=? AND artifact_id=?
         ORDER BY created_at, check_id`,
      )
      .all(scope.workspaceId, scope.projectId, artifactId) as Row[];
  }

  /** All check rows for one snapshot (release checks bind the PDF artifact). */
  listChecksBySnapshot(scope: Scope, snapshotId: string): Row[] {
    return this.db
      .prepare(
        `SELECT * FROM checks WHERE workspace_id=? AND project_id=? AND snapshot_id=?
         ORDER BY created_at, check_run_id`,
      )
      .all(scope.workspaceId, scope.projectId, snapshotId) as Row[];
  }

  // ---------- releases ----------
  insertRelease(scope: Scope, r: {
    releaseId: string;
    snapshotId: string;
    targetId: string;
    status: string;
    manifestJson: string;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO releases(workspace_id,project_id,release_id,snapshot_id,target_id,
           status,manifest_json,created_at)
         VALUES(?,?,?,?,?,?,?,?)`,
      )
      .run(
        scope.workspaceId, scope.projectId, r.releaseId, r.snapshotId, r.targetId,
        r.status, r.manifestJson, r.createdAt,
      );
  }

  getRelease(scope: Scope, releaseId: string): Row | null {
    const row = this.db
      .prepare(
        "SELECT * FROM releases WHERE workspace_id=? AND project_id=? AND release_id=?",
      )
      .get(scope.workspaceId, scope.projectId, releaseId);
    return (row as Row | undefined) ?? null;
  }

  /**
   * Status + manifest update. Releases are append-mostly: the row is created
   * as 'draft' and finalize moves it to a terminal state. There is no
   * delete; a blocked release stays blocked until a NEW release is cut.
   */
  updateRelease(scope: Scope, releaseId: string, fields: {
    status?: string;
    manifestJson?: string;
  }): void {
    this.db
      .prepare(
        `UPDATE releases SET status=COALESCE(?,status), manifest_json=COALESCE(?,manifest_json)
         WHERE workspace_id=? AND project_id=? AND release_id=?`,
      )
      .run(
        fields.status ?? null, fields.manifestJson ?? null,
        scope.workspaceId, scope.projectId, releaseId,
      );
  }

  listReleases(scope: Scope, filter: { snapshotId?: string } = {}): Row[] {
    let sql =
      "SELECT * FROM releases WHERE workspace_id=? AND project_id=?";
    const args: unknown[] = [scope.workspaceId, scope.projectId];
    if (filter.snapshotId !== undefined) {
      sql += " AND snapshot_id=?";
      args.push(filter.snapshotId);
    }
    sql += " ORDER BY created_at, release_id";
    return this.db.prepare(sql).all(...(args as string[])) as Row[];
  }

  /** Reviews recorded for one artifact (e.g. a page-image), oldest first. */
  listReviews(scope: Scope, artifactId: string): Row[] {
    return this.db
      .prepare(
        `SELECT * FROM reviews WHERE workspace_id=? AND project_id=? AND artifact_id=?
         ORDER BY created_at, rowid`,
      )
      .all(scope.workspaceId, scope.projectId, artifactId) as Row[];
  }

  /**
   * Reviews recorded for one rendered page of a pdf — across every rasterization.
   * Reviews bind to the page-image artifact they inspected, but page identity is
   * (pdfArtifactId, page): re-rendering the same pdf produces new page-image
   * artifacts while the human verdict stays valid. Oldest first.
   */
  listPageReviews(scope: Scope, pdfArtifactId: string, page: number): Row[] {
    return this.db
      .prepare(
        `SELECT r.* FROM reviews r
         JOIN artifacts a
           ON a.workspace_id=r.workspace_id AND a.project_id=r.project_id
          AND a.artifact_id=r.artifact_id AND a.snapshot_id=r.snapshot_id
         WHERE r.workspace_id=? AND r.project_id=?
           AND json_extract(a.manifest_json,'$.pdfArtifactId')=?
           AND json_extract(a.manifest_json,'$.page')=?
         ORDER BY r.created_at, r.rowid`,
      )
      .all(scope.workspaceId, scope.projectId, pdfArtifactId, page) as Row[];
  }

  insertReview(scope: Scope, r: {
    reviewId: string;
    artifactId: string;
    snapshotId: string;
    inputDigest: string;
    reviewerId: string;
    reviewerKind: string;
    resultJson: string;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO reviews(workspace_id,project_id,review_id,artifact_id,snapshot_id,
           input_digest,reviewer_id,reviewer_kind,result_json,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        scope.workspaceId, scope.projectId, r.reviewId, r.artifactId, r.snapshotId,
        r.inputDigest, r.reviewerId, r.reviewerKind, r.resultJson, r.createdAt,
      );
  }

  // ---------- idempotency_records ----------
  getIdempotencyRecord(scope: Scope, principalId: string, key: string): Row | null {
    const row = this.db
      .prepare(
        `SELECT * FROM idempotency_records
         WHERE workspace_id=? AND project_id=? AND principal_id=? AND idempotency_key=?`,
      )
      .get(scope.workspaceId, scope.projectId, principalId, key);
    return (row as Row | undefined) ?? null;
  }

  updateIdempotencyRecord(
    scope: Scope,
    principalId: string,
    key: string,
    fields: { state: string; resultJson: string | null },
  ): void {
    this.db
      .prepare(
        `UPDATE idempotency_records SET state=?, result_json=?
         WHERE workspace_id=? AND project_id=? AND principal_id=? AND idempotency_key=?`,
      )
      .run(
        fields.state,
        fields.resultJson,
        scope.workspaceId,
        scope.projectId,
        principalId,
        key,
      );
  }

  putIdempotencyRecord(scope: Scope, record: NewIdempotencyRecord): void {
    this.db
      .prepare(
        `INSERT INTO idempotency_records(workspace_id,project_id,principal_id,idempotency_key,
           action,input_digest,state,result_json,created_at)
         VALUES(?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        scope.workspaceId,
        scope.projectId,
        record.principalId,
        record.idempotencyKey,
        record.action,
        record.inputDigest,
        record.state,
        record.resultJson,
        record.createdAt,
      );
  }

  // ---------- audit_events ----------
  insertAuditEvent(
    scope: Scope,
    event: {
      eventId: string;
      principalId: string;
      action: string;
      resourceId: string | null;
      outcome: string;
      detailJson: string;
      createdAt: string;
    },
  ): void {
    this.db
      .prepare(
        `INSERT INTO audit_events(workspace_id,project_id,event_id,principal_id,action,
           resource_id,outcome,detail_json,created_at)
         VALUES(?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        scope.workspaceId,
        scope.projectId,
        event.eventId,
        event.principalId,
        event.action,
        event.resourceId,
        event.outcome,
        event.detailJson,
        event.createdAt,
      );
  }

  listAuditEvents(scope: Scope): Row[] {
    return this.db
      .prepare(
        "SELECT * FROM audit_events WHERE workspace_id=? AND project_id=? ORDER BY created_at, event_id",
      )
      .all(scope.workspaceId, scope.projectId) as Row[];
  }

  // ---------- project_events (transactional outbox) ----------
  /**
   * Allocate the next project seq and insert the event. MUST be called inside
   * inTransaction(); the seq bump and the insert commit or roll back together,
   * so the stream is gap-free and strictly monotonic per project.
   */
  emitProjectEventInTx(
    scope: Scope,
    event: {
      jobId: string | null;
      eventJson: string | ((seq: number) => string);
      createdAt: string;
    },
  ): number {
    const row = this.db
      .prepare(
        `UPDATE projects SET event_seq=event_seq+1
         WHERE workspace_id=? AND project_id=? RETURNING event_seq`,
      )
      .get(scope.workspaceId, scope.projectId) as Row | undefined;
    if (row === undefined) {
      throw new WorkbenchError(
        ERROR_CODES.NOT_FOUND,
        `project ${scope.workspaceId}/${scope.projectId} does not exist`,
      );
    }
    const seq = row["event_seq"] as number;
    const eventJson =
      typeof event.eventJson === "function" ? event.eventJson(seq) : event.eventJson;
    // Events are the replay contract — validate against the Event schema at
    // emit time so a malformed payload is a loud failure, never persisted.
    const parsed = JSON.parse(eventJson) as unknown;
    const validate = validatorFor("Event");
    if (!validate(parsed)) {
      throw new WorkbenchError(
        ERROR_CODES.SCHEMA_VALIDATION_FAILED,
        `project event failed schema validation: ${formatErrors(validate.errors)}`,
      );
    }
    this.db
      .prepare(
        `INSERT INTO project_events(workspace_id,project_id,seq,job_id,event_json,created_at)
         VALUES(?,?,?,?,?,?)`,
      )
      .run(scope.workspaceId, scope.projectId, seq, event.jobId, eventJson, event.createdAt);
    return seq;
  }

  projectEventsAfter(scope: Scope, afterSeq: number, limit = 200): Row[] {
    return this.db
      .prepare(
        `SELECT * FROM project_events WHERE workspace_id=? AND project_id=? AND seq>?
         ORDER BY seq LIMIT ?`,
      )
      .all(scope.workspaceId, scope.projectId, afterSeq, limit) as Row[];
  }
}
