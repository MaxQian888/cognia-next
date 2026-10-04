/**
 * Host operation registry (M2-B). A STATIC map of host-owned operation
 * implementations — nothing is loaded from a project tree, there is no
 * eval, no dynamic import, no JSONPath. Every registered operation either
 * has a real implementation here or an explicit `unsupportedReason` in
 * `resources/workflows/operation-registry.json`; drift between the two is a
 * hard startup error (assertRegistryConsistency), never a warning.
 *
 * Agent operations are deliberately implemented as a WATING-INPUT seam:
 * the engine never calls a model. The step pauses with a typed request
 * describing what the host must supply (a patchId proposed against the
 * current head for propose-* operations); `resumeWorkflow` validates and
 * delivers it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalJson,
  ERROR_CODES,
  NotImplementedError,
  utcNowIso,
  digestJson,
  WorkbenchError,
  type BuildResult,
  type Diagnostic,
  type DiagramSpec,
  type HostPolicy,
  type PlotParams,
  type TableSpec,
  type Target,
  type WorkflowNode,
  type WorkflowSpec,
} from "@latexwb/contracts";
import type { BlobStore, Row, Scope, WorkbenchStore } from "@latexwb/storage";
import { requireCapability } from "./capabilities.ts";
import type { RequestContext } from "./context.ts";
import { applyPatch } from "./patch.ts";
import { checkBudget, recordApply, recordCauseAttempt, readBudget } from "./budget.ts";
import { inspectDerived, resolveTarget } from "./inspect.ts";
import {
  auditBibliography,
  bibliographyReport,
  proposeBibliographyImport,
  resolveCitations,
} from "./bibliography.ts";
import { generateDataAsset, inspectSourceAsset, resolveSourceAsset } from "./assets.ts";
import { runDataAssetChecks, runReleaseChecks } from "./checks.ts";
import {
  evaluateReleaseGates,
  finalizeRelease,
  freezeRelease,
  rebuildPackage,
  releaseApprovalDigest,
  RELEASE_PACKAGE_ACTION,
  stagePackage,
  stageWhitelist,
  type ReleaseDeps,
  type ReleaseProfileId,
} from "./release.ts";
import { pageReviewCoverage } from "./review.ts";
import { initApprovedProject } from "./init.ts";
import { parseCsv } from "./csv.ts";
import type { BuildService } from "./build.ts";
import { verifyVenueSources } from "./venue.ts";
import type { Fetcher } from "./net.ts";
import { loadOperationRegistry, type OperationRegistryEntry } from "./workflow-defs.ts";

/** Workflow context — the declared fields a binding may name. */
export interface WorkflowContext {
  snapshotId: string | null;
  targetId: string | null;
  pdfArtifactId: string | null;
  /** The patch this workflow is currently carrying (host-supplied). */
  patchId?: string | undefined;
  /** Normalized causeId of the last failing build's first diagnostic. */
  causeId?: string | undefined;
  baselineArtifactId?: string | undefined;
  // ---- M3 fields -------------------------------------------------------
  /** Approved template id for project.init-approved (host-supplied). */
  templateId?: string | undefined;
  /** Target id init should register (default "default"). */
  initTargetId?: string | undefined;
  /** .bib paths the audit resolved (snapshot-relative). */
  bibPaths?: string[] | undefined;
  /** Persisted candidate ids from resolve-approved. */
  candidateIds?: string[] | undefined;
  /** Cited keys with no local definition, from the last audit. */
  missingBibKeys?: string[] | undefined;
  /** Persisted audit/report artifact ids. */
  bibReportArtifactId?: string | undefined;
  auditReportArtifactId?: string | undefined;
  /** Data assets discovered by assets.inspect-source. */
  dataAssetIds?: string[] | undefined;
  /** The generated .tex/pdf artifact of assets.generate-approved. */
  generatedArtifactId?: string | undefined;
  /** The CheckReport artifact of assets.check-mapping-and-layout. */
  checkReportArtifactId?: string | undefined;
  /**
   * Host-supplied generation request for assets.generate-approved — the
   * FigureInput payload minus projectId/snapshotId. When absent the op
   * generates a default booktabs table of the first inspected data asset.
   */
  assetSpec?:
    | { action: "table"; sourceAssetId: string; tableSpec: TableSpec }
    | { action: "plot"; sourceAssetId: string; recipeId: string; params: PlotParams }
    | { action: "diagram"; sourceAssetId: string; recipeId: string; diagramSpec: DiagramSpec }
    | undefined;
  /**
   * Set by propose/verify ops when nothing changed — gate and apply then
   * take the verified no-change path instead of demanding a patchId.
   */
  noChange?: boolean | undefined;
  // ---- M4 fields -------------------------------------------------------
  /** Release row id created by release.freeze. */
  releaseId?: string | undefined;
  /** draft | review | submission — set by release.freeze from context. */
  releaseProfileId?: string | undefined;
  /** sha256 digest of the whitelist manifest the package approval binds to. */
  whitelistDigest?: string | undefined;
  whitelistArtifactId?: string | undefined;
  /** Staged source-zip + package manifest artifacts. */
  sourceZipArtifactId?: string | undefined;
  packageManifestArtifactId?: string | undefined;
  /** Clean-room rebuild job of release.rebuild-package. */
  rebuildJobId?: string | undefined;
}

/** What a waiting step asks the host for — recorded on the step run. */
export interface PendingRequest {
  kind: "patch-proposal" | "approval" | "host-input";
  /** Context field a validated input lands in (patch-proposal → "patchId"). */
  inputField?: string;
  /** For patch-proposal: the base the supplied patch must be based on. */
  baseSnapshotId?: string;
  /** For approval: the grant the gate waits on. */
  action?: string;
  scopeDigest?: string;
  patchId?: string;
  description: string;
}

export type StepDecision =
  | { kind: "success"; result: unknown; contextUpdates?: Partial<WorkflowContext>; jobId?: string }
  | {
      kind: "failure";
      reason: string;
      result?: unknown;
      contextUpdates?: Partial<WorkflowContext>;
      jobId?: string;
    }
  | { kind: "waiting-input"; request: PendingRequest }
  | { kind: "waiting-approval"; request: PendingRequest };

export interface OperationRunEnv {
  store: WorkbenchStore;
  blobs: BlobStore;
  ctx: RequestContext;
  scope: Scope;
  workflowId: string;
  stepRunId: string;
  node: WorkflowNode;
  spec: WorkflowSpec;
  context: WorkflowContext;
  resolved: Record<string, string | null>;
  buildService: BuildService;
  repoRoot: string;
  /** Test seam for outbound fetches (venue source verification). */
  fetchImpl?: Fetcher | undefined;
}

export interface OperationImpl {
  id: string;
  version: number;
  type: string;
  run(env: OperationRunEnv): Promise<StepDecision> | StepDecision;
}

type FailureExtras = Partial<
  Extract<StepDecision, { kind: "failure" }> & { kind: never }
>;

function failure(reason: string, extra?: FailureExtras): StepDecision {
  return { kind: "failure", reason, ...extra };
}

function headSnapshotId(store: WorkbenchStore, scope: Scope): string {
  const project = store.getProject(scope);
  if (project === null) {
    throw new WorkbenchError(ERROR_CODES.NOT_FOUND, `project ${scope.projectId} not found`);
  }
  const head = project["head_snapshot_id"] as string | null;
  if (head === null) {
    throw new WorkbenchError(ERROR_CODES.NOT_FOUND, `project ${scope.projectId} has no head snapshot`);
  }
  return head;
}

function currentPatch(env: OperationRunEnv): Row {
  const patchId = env.context.patchId;
  if (patchId === undefined) {
    throw new WorkbenchError(ERROR_CODES.INVALID_REQUEST, "workflow context carries no patchId");
  }
  const row = env.store.getPatch(env.scope, patchId);
  if (row === null) {
    throw new WorkbenchError(ERROR_CODES.NOT_FOUND, `patch ${patchId} not found in scope`);
  }
  return row;
}

function summarizeDiagnostics(diagnostics: Diagnostic[]): Record<string, unknown>[] {
  return diagnostics.slice(0, 8).map((d) => ({
    code: d.code,
    severity: d.severity,
    message: d.message.slice(0, 240),
    source: d.source,
    causeId: d.causeId,
  }));
}

function hostPolicyOf(repoRoot: string): HostPolicy | null {
  try {
    return JSON.parse(
      readFileSync(join(repoRoot, "runtime", "host-policy.json"), "utf8"),
    ) as HostPolicy;
  } catch {
    return null;
  }
}

/** The .bib paths a workflow audits — context wins, else every .bib in the snapshot. */
function bibPathsOf(env: OperationRunEnv, snapshotId: string): string[] {
  if (env.context.bibPaths !== undefined && env.context.bibPaths.length > 0) {
    return env.context.bibPaths;
  }
  return env.store
    .listSnapshotFiles(env.scope, snapshotId)
    .map((r) => r["path"] as string)
    .filter((p) => p.toLowerCase().endsWith(".bib"))
    .sort();
}

function requireContextSnapshot(env: OperationRunEnv): string {
  const snapshotId = env.resolved["snapshot"] ?? env.context.snapshotId;
  if (snapshotId === null || snapshotId === undefined) {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `operation ${env.node.operationId} requires a snapshotId in the workflow context`,
    );
  }
  return snapshotId;
}

function requireContextRelease(env: OperationRunEnv): string {
  const releaseId = env.context.releaseId;
  if (releaseId === undefined) {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `operation ${env.node.operationId} requires context.releaseId — release.freeze must run first`,
    );
  }
  return releaseId;
}

function releaseDeps(env: OperationRunEnv): ReleaseDeps {
  return {
    store: env.store,
    blobs: env.blobs,
    ctx: env.ctx,
    scope: env.scope,
    repoRoot: env.repoRoot,
    hostPolicy: hostPolicyOf(env.repoRoot),
    buildService: env.buildService,
    jobs: env.buildService.jobService(),
  };
}

/** Shared body of build.run-await / build.clean-await. */
async function runBuildStep(env: OperationRunEnv, clean: boolean): Promise<StepDecision> {
  const snapshotId = env.resolved["snapshot"] ?? env.context.snapshotId;
  const targetId = env.resolved["target"] ?? env.context.targetId;
  const outcome = await env.buildService.build(env.scope, env.ctx, {
    snapshotId,
    targetId,
    clean,
  });
  const br = outcome.buildResult;
  const jobId = outcome.job.jobId;
  if (br === null) {
    return failure(`build job ${jobId} ended ${outcome.job.state} with no build result`, {
      jobId,
    });
  }
  const contextUpdates: Partial<WorkflowContext> = { snapshotId: br.snapshotId };
  if (br.pdfArtifactId !== null) contextUpdates.pdfArtifactId = br.pdfArtifactId;
  if (br.status === "compiled") {
    return {
      kind: "success",
      result: {
        jobId,
        status: br.status,
        exitCode: br.exitCode,
        durationMs: br.durationMs,
        cacheHit: br.cacheHit,
        pdfArtifactId: br.pdfArtifactId,
        diagnostics: summarizeDiagnostics(br.diagnostics),
      },
      contextUpdates,
      jobId,
    };
  }
  const first = br.diagnostics.find((d) => d.severity === "error") ?? br.diagnostics[0];
  if (first !== undefined && first.causeId !== null) contextUpdates.causeId = first.causeId;
  return failure(`build ${br.status}: ${first?.code ?? "unknown"} — ${first?.message ?? ""}`, {
    result: {
      jobId,
      status: br.status,
      diagnostics: summarizeDiagnostics(br.diagnostics),
    },
    contextUpdates,
    jobId,
  });
}

const OPERATION_IMPLS: OperationImpl[] = [
  {
    id: "project.inspect",
    version: 2,
    type: "operation",
    run(env) {
      const { store, blobs, scope, context } = env;
      const project = store.getProject(scope);
      const head = (project?.["head_snapshot_id"] as string | null | undefined) ?? null;
      const snapshotId = env.resolved["snapshot"] ?? context.snapshotId ?? head;
      if (snapshotId === null) {
        // Empty project is a legitimate inspect result — init's whole job
        // is deciding what to put into one.
        return {
          kind: "success",
          result: {
            empty: true,
            projectId: scope.projectId,
            rootCandidates: 0,
            bibliographyPaths: [],
            assets: 0,
          },
        };
      }
      const existingTargets = store
        .listTargets(scope)
        .map((r) => JSON.parse(r["config_json"] as string));
      const { inspection, derived } = inspectDerived({
        store,
        blobs,
        scope,
        snapshotId,
        projectId: scope.projectId,
        existingTargets,
      });
      const requested = env.resolved["target"] ?? context.targetId ?? null;
      const target = resolveTarget(inspection, derived, {
        requestedTargetId: requested,
        engineFallback: "xelatex",
        presetForEngine: (engine) =>
          engine === "xelatex" ? "local-tectonic-xelatex" : `docker-texlive-${engine}`,
      });
      if (target === null) {
        return failure(
          `TARGET_AMBIGUOUS: could not resolve a single build root; candidates: ${
            inspection.rootCandidates.map((c) => c.path).join(", ") || "none"
          }`,
        );
      }
      store.putTarget(scope, target.id, canonicalJson(target), digestJson(target));
      return {
        kind: "success",
        result: {
          targetId: target.id,
          root: target.root,
          engine: derived.engine,
          bibliographyMode: derived.bibliographyMode,
          rootCandidates: inspection.rootCandidates.length,
          untrustedConfigFiles: inspection.untrustedConfigFiles ?? [],
        },
        contextUpdates: { snapshotId, targetId: target.id },
      };
    },
  },
  {
    id: "build.run-await",
    version: 1,
    type: "operation",
    async run(env) {
      return runBuildStep(env, false);
    },
  },
  {
    id: "build.clean-await",
    version: 1,
    type: "operation",
    async run(env) {
      return runBuildStep(env, true);
    },
  },
  {
    id: "patch.apply-current",
    version: 2,
    type: "operation",
    run(env) {
      // Verified no-change path: a propose step that found nothing to change
      // sets noChange — there is legitimately no patch to apply.
      if (env.context.noChange === true && env.context.patchId === undefined) {
        const head = headSnapshotId(env.store, env.scope);
        return {
          kind: "success",
          result: { applied: false, noChange: true, snapshotId: head },
          contextUpdates: { snapshotId: head },
        };
      }
      const patch = currentPatch(env);
      const patchId = patch["patch_id"] as string;
      const head = headSnapshotId(env.store, env.scope);
      if ((patch["base_snapshot_id"] as string) !== head) {
        return failure(
          `STALE_BASE: patch ${patchId} is based on ${patch["base_snapshot_id"]}, head is ${head}`,
        );
      }
      let applied;
      try {
        applied = applyPatch({
          store: env.store,
          blobs: env.blobs,
          ctx: env.ctx,
          scope: env.scope,
          patchId,
        });
      } catch (error) {
        if (error instanceof WorkbenchError) {
          return failure(`${error.code}: ${error.message}`);
        }
        throw error;
      }
      // Budget accounting: an application is counted only after a real apply.
      recordApply(env.store, env.scope, env.workflowId, utcNowIso());
      return {
        kind: "success",
        result: {
          patchId,
          previousSnapshotId: applied.previousSnapshotId,
          snapshotId: applied.snapshotId,
        },
        contextUpdates: { snapshotId: applied.snapshotId },
      };
    },
  },
  {
    id: "gate.patch-approval",
    version: 2,
    type: "gate",
    run(env) {
      // Verified no-change path — no patch was produced, nothing to approve.
      if (env.context.noChange === true && env.context.patchId === undefined) {
        return { kind: "success", result: { approvalRequired: false, noChange: true } };
      }
      const patch = currentPatch(env);
      const patchId = patch["patch_id"] as string;
      const digest = patch["patch_digest"] as string;
      const base = patch["base_snapshot_id"] as string;
      const protectedChanges = JSON.parse(patch["protected_changes_json"] as string) as unknown[];
      if (protectedChanges.length === 0) {
        return { kind: "success", result: { patchId, approvalRequired: false } };
      }
      const now = utcNowIso();
      env.store.expireApprovals(env.scope, now);
      const usable = env.store.findUsableApproval(
        env.scope, "patch.apply", digest, base, env.ctx.policyId, now,
      );
      if (usable !== null) {
        return {
          kind: "success",
          result: { patchId, approvalRequired: true, approvalId: usable["approval_id"] },
        };
      }
      // A missing grant is WAITING, not failure — the shipped node
      // description is explicit that no answer stays waiting. Failure only
      // when grants exist but none is usable (revoked/expired denial).
      const grants = env.store
        .listApprovals(env.scope)
        .filter((a) => (a["scope_digest"] as string) === digest);
      const denied = grants.some((g) => ["revoked", "expired"].includes(g["state"] as string));
      if (denied) {
        return failure(
          `approval for patch ${patchId} exists but none is usable (revoked or expired)`,
        );
      }
      return {
        kind: "waiting-approval",
        request: {
          kind: "approval",
          action: "patch.apply",
          scopeDigest: digest,
          patchId,
          baseSnapshotId: base,
          description: `patch ${patchId} has ${protectedChanges.length} protected change(s); a host grant for action 'patch.apply' bound to digest ${digest.slice(0, 12)}… is required`,
        },
      };
    },
  },
  {
    id: "guard.repair-budget",
    version: 1,
    type: "switch",
    run(env) {
      const limits = {
        maxPatchApplications: env.spec.maxPatchApplications,
        maxSameCauseAttempts: env.spec.maxSameCauseAttempts,
      };
      const causeId = env.context.causeId ?? null;
      const reason = checkBudget(env.store, env.scope, env.workflowId, causeId, limits);
      if (reason !== null) {
        return failure(`budget exhausted: ${reason}`, { result: readBudget(env.store, env.scope, env.workflowId) });
      }
      // The guard records the cause attempt — the normalized fingerprint of
      // the failing build's first diagnostic, never a log hash, and never
      // influenced by model output.
      if (causeId !== null) {
        recordCauseAttempt(env.store, env.scope, env.workflowId, causeId, utcNowIso());
      }
      return {
        kind: "success",
        result: { allowed: true, budget: readBudget(env.store, env.scope, env.workflowId) },
      };
    },
  },
  {
    id: "baseline.capture",
    version: 1,
    type: "operation",
    run(env) {
      const head = headSnapshotId(env.store, env.scope);
      const snapshot = env.store.getSnapshot(env.scope, head) as Row;
      // Latest compiled build for this head gives the usable PDF, if any.
      const pdfArtifactId = env.store
        .listJobs(env.scope, { limit: 500 })
        .filter(
          (r) =>
            (r["state"] as string) === "succeeded" &&
            (r["snapshot_id"] as string | null) === head,
        )
        .map((r) => {
          try {
            return (
              (JSON.parse((r["result_json"] as string) ?? "{}") as { buildResult?: BuildResult })
                .buildResult?.pdfArtifactId ?? null
            );
          } catch {
            return null;
          }
        })
        .filter((id): id is string => id !== null)
        .at(-1) ?? null;
      return {
        kind: "success",
        result: {
          snapshotId: head,
          treeHash: snapshot["tree_hash"],
          pdfArtifactId,
          capturedAt: utcNowIso(),
        },
        contextUpdates: {
          snapshotId: head,
          baselineArtifactId: pdfArtifactId ?? undefined,
          ...(pdfArtifactId !== null ? { pdfArtifactId } : {}),
        },
      };
    },
  },
  {
    // Machine-checkable part of draft review only: gathers real facts —
    // open diagnostics on the latest build, protected changes carried by
    // applied patches in this run — and records that visual review has NOT
    // happened. It never claims a document is clean.
    id: "quality.review-draft",
    version: 1,
    type: "operation",
    run(env) {
      const head = headSnapshotId(env.store, env.scope);
      const latestBuild = env.store
        .listJobs(env.scope, { limit: 500 })
        .filter(
          (r) =>
            (r["state"] as string) === "succeeded" &&
            (r["snapshot_id"] as string | null) === head,
        )
        .at(-1);
      const buildResult =
        latestBuild === undefined
          ? null
          : (JSON.parse((latestBuild["result_json"] as string) ?? "{}") as {
              buildResult?: BuildResult;
            }).buildResult ?? null;
      const appliedPatches = env.store
        .listWorkflowSteps(env.scope, env.workflowId)
        .filter((s) => (s["state"] as string) === "completed")
        .map((s) => {
          try {
            const res = JSON.parse((s["result_json"] as string) ?? "{}") as {
              result?: { patchId?: string };
            };
            return res.result?.patchId ?? null;
          } catch {
            return null;
          }
        })
        .filter((id): id is string => id !== null)
        .map((id) => env.store.getPatch(env.scope, id))
        .filter((p): p is Row => p !== null);
      const protectedChanges = appliedPatches.flatMap(
        (p) => JSON.parse(p["protected_changes_json"] as string) as unknown[],
      );
      const openErrors = (buildResult?.diagnostics ?? []).filter((d) => d.severity === "error");
      const needsReview = [
        "visual-page-review", // no render backend yet — always outstanding
        ...new Set(protectedChanges.map((c) => `protected.${(c as { category: string }).category}`)),
        ...openErrors.map((d) => `diagnostic.${d.code}`),
      ];
      return {
        kind: "success",
        result: {
          kind: "draft-review",
          snapshotId: head,
          machineChecks: {
            latestBuildStatus: buildResult?.status ?? null,
            openErrorCount: openErrors.length,
            protectedChangesApplied: protectedChanges.length,
          },
          needsReview,
          visualReview: "not-performed",
        },
      };
    },
  },
  // ------------------------------------------------------------------ M3
  {
    id: "project.init-approved",
    version: 1,
    type: "operation",
    run(env) {
      const templateId = env.context.templateId;
      if (templateId === undefined) {
        return failure(
          "INVALID_REQUEST: context.templateId is required — init only copies host-approved templates and the host must name one",
        );
      }
      const targetId = env.context.initTargetId ?? env.context.targetId ?? "default";
      try {
        const out = initApprovedProject({
          store: env.store,
          blobs: env.blobs,
          ctx: env.ctx,
          scope: env.scope,
          repoRoot: env.repoRoot,
          templateId,
          targetId,
        });
        return {
          kind: "success",
          result: {
            templateId,
            targetId: out.target.id,
            snapshotId: out.snapshot.snapshotId,
            files: out.files,
            createdProject: out.createdProject,
          },
          contextUpdates: {
            snapshotId: out.snapshot.snapshotId,
            targetId: out.target.id,
          },
        };
      } catch (error) {
        if (error instanceof WorkbenchError) {
          return failure(`${error.code}: ${error.message}`);
        }
        throw error;
      }
    },
  },
  {
    id: "bibliography.audit",
    version: 1,
    type: "operation",
    async run(env) {
      const snapshotId = requireContextSnapshot(env);
      const bibPaths = bibPathsOf(env, snapshotId);
      const out = await auditBibliography(
        { store: env.store, blobs: env.blobs, ctx: env.ctx, scope: env.scope },
        { snapshotId, bibPaths },
      );
      const summary = {
        entries: out.audit.entries.length,
        missing: out.audit.entries.filter((e) => e.metadata === "not-found").length,
        conflicts: out.audit.entries.filter((e) => e.metadata === "conflict").length,
        syntaxInvalid: out.audit.entries.filter((e) => e.syntax === "invalid").length,
      };
      return {
        kind: "success",
        result: {
          audit: out.audit,
          reportArtifactId: out.reportArtifactId,
          bibPaths,
          summary,
        },
        contextUpdates: { bibPaths, auditReportArtifactId: out.reportArtifactId },
        jobId: out.jobId,
      };
    },
  },
  {
    id: "bibliography.resolve-approved",
    version: 1,
    type: "operation",
    async run(env) {
      const snapshotId = requireContextSnapshot(env);
      const bibPaths = bibPathsOf(env, snapshotId);
      const out = await resolveCitations(
        {
          store: env.store,
          blobs: env.blobs,
          ctx: env.ctx,
          scope: env.scope,
          repoRoot: env.repoRoot,
          hostPolicy: hostPolicyOf(env.repoRoot),
        },
        { snapshotId, bibPaths },
      );
      return {
        kind: "success",
        result: {
          candidateIds: out.candidateIds,
          missingKeys: out.missingKeys,
          warnings: out.warnings,
        },
        contextUpdates: {
          candidateIds: out.candidateIds,
          missingBibKeys: out.missingKeys,
        },
        jobId: out.jobId,
      };
    },
  },
  {
    id: "bibliography.propose-import",
    version: 1,
    type: "operation",
    async run(env) {
      const snapshotId = requireContextSnapshot(env);
      const candidateIds = env.context.candidateIds ?? [];
      if (candidateIds.length === 0) {
        // Verified no-change: resolve found nothing admissible to import.
        return {
          kind: "success",
          result: { noChange: true, reason: "no approved candidates to import" },
          contextUpdates: { noChange: true },
        };
      }
      const bibPath = env.context.bibPaths?.[0] ?? "references.bib";
      const out = await proposeBibliographyImport(
        { store: env.store, blobs: env.blobs, ctx: env.ctx, scope: env.scope },
        { baseSnapshotId: snapshotId, bibPath, candidateIds },
      );
      if (out.proposal === null) {
        return {
          kind: "success",
          result: {
            noChange: true,
            skipped: out.skipped,
            warnings: out.warnings,
          },
          contextUpdates: { noChange: true },
        };
      }
      return {
        kind: "success",
        result: {
          patchId: out.proposal.patchId,
          digest: out.proposal.digest,
          changedPaths: out.proposal.changedPaths,
          protectedChanges: out.proposal.protectedChanges.length,
          skipped: out.skipped,
          warnings: out.warnings,
        },
        contextUpdates: { patchId: out.proposal.patchId },
      };
    },
  },
  {
    id: "bibliography.report",
    version: 1,
    type: "operation",
    run(env) {
      const snapshotId = requireContextSnapshot(env);
      const bibPaths = bibPathsOf(env, snapshotId);
      const out = bibliographyReport(
        { store: env.store, blobs: env.blobs, ctx: env.ctx, scope: env.scope },
        { snapshotId, bibPaths },
      );
      return {
        kind: "success",
        result: {
          reportArtifactId: out.reportArtifactId,
          summary: out.summary,
          entries: out.entries,
        },
        ...(out.reportArtifactId !== null
          ? { contextUpdates: { bibReportArtifactId: out.reportArtifactId } }
          : {}),
      };
    },
  },
  {
    id: "assets.inspect-source",
    version: 1,
    type: "operation",
    async run(env) {
      const snapshotId = requireContextSnapshot(env);
      const dataFiles = env.store
        .listSnapshotFiles(env.scope, snapshotId)
        .filter((r) => /\.(csv|tsv)$/i.test(r["path"] as string));
      const dataAssetIds: string[] = [];
      const inspections: unknown[] = [];
      const jobIds: string[] = [];
      for (const row of dataFiles) {
        const assetId = `asset-${(row["blob_hash"] as string).slice(0, 12)}`;
        const out = await inspectSourceAsset(
          {
            store: env.store,
            blobs: env.blobs,
            ctx: env.ctx,
            scope: env.scope,
            repoRoot: env.repoRoot,
            hostPolicy: hostPolicyOf(env.repoRoot),
            presetsDir: join(env.repoRoot, "runtime", "presets"),
          },
          { snapshotId, sourceAssetId: assetId },
        );
        dataAssetIds.push(assetId);
        inspections.push(out.inspection);
        jobIds.push(out.jobId);
      }
      return {
        kind: "success",
        result: {
          dataAssetIds,
          inspections,
          empty: dataAssetIds.length === 0,
        },
        contextUpdates: { dataAssetIds },
        ...(jobIds.length > 0 ? { jobId: jobIds[0] } : {}),
      };
    },
  },
  {
    id: "assets.generate-approved",
    version: 1,
    type: "operation",
    async run(env) {
      const snapshotId = requireContextSnapshot(env);
      const assetDeps = {
        store: env.store,
        blobs: env.blobs,
        ctx: env.ctx,
        scope: env.scope,
        repoRoot: env.repoRoot,
        hostPolicy: hostPolicyOf(env.repoRoot),
        presetsDir: join(env.repoRoot, "runtime", "presets"),
      };
      const spec = env.context.assetSpec;
      let input: Parameters<typeof generateDataAsset>[1];
      if (spec !== undefined) {
        input = { snapshotId, ...spec };
      } else {
        // Deterministic default: a booktabs table of every column of the
        // first inspected data asset. Real data — never invented numbers.
        const first = env.context.dataAssetIds?.[0];
        if (first === undefined) {
          return failure(
            "no data assets discovered by assets.inspect-source and no assetSpec in the workflow context — nothing to generate",
          );
        }
        const asset = resolveSourceAsset(env.store, env.blobs, env.scope, snapshotId, first);
        const data = parseCsv(asset.bytes);
        const tableSpec: TableSpec = {
          columns: data.columns.slice(0, 40).map((c) => ({
            field: c.field,
            label: c.field,
            unit: c.unit,
            decimalPlaces: null,
          })),
          roundingMode: "half-even",
          missingValue: "\\textemdash{}",
          caption: `Data from ${asset.path}`,
          label: `tab:${first}`,
        };
        input = { action: "table", snapshotId, sourceAssetId: first, tableSpec };
      }
      const out = await generateDataAsset(assetDeps, input);
      const contextUpdates: Partial<WorkflowContext> = {
        generatedArtifactId: out.result.artifactId,
      };
      if (out.compileProof === "failed") {
        return failure(
          `generated asset failed to compile: ${out.diagnostics[0]?.message ?? "see job log"}`,
          {
            result: {
              generatedAssetId: out.result.artifactId,
              diagnostics: summarizeDiagnostics(out.diagnostics),
            },
            contextUpdates,
            jobId: out.jobId,
          },
        );
      }
      return {
        kind: "success",
        result: {
          generated: out.result,
          texArtifactId: out.texArtifactId,
          pdfArtifactId: out.pdfArtifactId,
          compileProof: out.compileProof,
          diagnostics: summarizeDiagnostics(out.diagnostics),
        },
        contextUpdates,
        jobId: out.jobId,
      };
    },
  },
  {
    id: "assets.check-mapping-and-layout",
    version: 1,
    type: "operation",
    async run(env) {
      const artifactId = env.context.generatedArtifactId ?? env.resolved["artifact"];
      if (artifactId === null || artifactId === undefined) {
        return failure(
          "no generated artifact in the workflow context — generate must run first",
        );
      }
      const out = await runDataAssetChecks(
        {
          store: env.store,
          blobs: env.blobs,
          ctx: env.ctx,
          scope: env.scope,
          hostPolicy: hostPolicyOf(env.repoRoot),
        },
        { artifactId, rulesetId: "data-assets" },
      );
      const contextUpdates: Partial<WorkflowContext> = {
        checkReportArtifactId: out.reportArtifactId,
      };
      if (out.report.blockingIds.length > 0) {
        return failure(
          `check report ${out.reportArtifactId} has blocking failures: ${out.report.blockingIds.join(", ")}`,
          {
            result: { report: out.report, reportArtifactId: out.reportArtifactId },
            contextUpdates,
            jobId: out.jobId,
          },
        );
      }
      return {
        kind: "success",
        result: {
          reportArtifactId: out.reportArtifactId,
          blockingIds: out.report.blockingIds,
          missingReviewIds: out.report.missingReviewIds,
          results: out.report.results.map((r) => ({
            checkId: r.checkId,
            status: r.status,
            severity: r.severity,
          })),
        },
        contextUpdates,
        jobId: out.jobId,
      };
    },
  },
  // ------------------------------------------------------------------ M4
  {
    id: "venue.verify-current",
    version: 1,
    type: "operation",
    async run(env) {
      const snapshotId = env.resolved["snapshot"] ?? env.context.snapshotId;
      const targetId = env.resolved["target"] ?? env.context.targetId;
      if (snapshotId === null || snapshotId === undefined) {
        return failure("venue.verify-current requires context.snapshotId");
      }
      if (targetId === null || targetId === undefined) {
        return failure("venue.verify-current requires context.targetId");
      }
      const targetRow = env.store.getTarget(env.scope, targetId);
      if (targetRow === null) {
        return failure(`target ${targetId} not found`);
      }
      const target = JSON.parse(targetRow["config_json"] as string) as Target;
      if (target.venueProfileId == null) {
        return failure(`target ${targetId} declares no venueProfileId — nothing to verify`);
      }
      try {
        const out = await verifyVenueSources(
          {
            store: env.store,
            blobs: env.blobs,
            ctx: env.ctx,
            scope: env.scope,
            repoRoot: env.repoRoot,
            hostPolicy: hostPolicyOf(env.repoRoot),
            fetchImpl: env.fetchImpl,
          },
          { venueProfileId: target.venueProfileId, snapshotId },
        );
        const result = {
          venueProfileId: out.venueProfileId,
          checkedAt: out.checkedAt,
          verified: out.verified,
          sources: out.sources.map((s) => ({
            sourceId: s.sourceId,
            url: s.url,
            status: s.status,
            expectedHash: s.expectedHash,
            fetchedHash: s.fetchedHash,
            httpStatus: s.httpStatus,
            evidenceId: s.evidenceId,
          })),
          evidenceIds: out.evidenceIds,
          note: out.note,
        };
        if (!out.verified) {
          // "模板来源未核验停止" — an unverifiable or changed source stops the
          // migration honestly instead of letting the plan run on stale facts.
          return failure(
            `venue profile ${out.venueProfileId} is not verified-current: ${out.note ?? "no sources verified"}`,
            { result },
          );
        }
        return { kind: "success", result };
      } catch (error) {
        return failure(
          error instanceof WorkbenchError
            ? `${error.code}: ${error.message}`
            : error instanceof Error
              ? error.message
              : String(error),
        );
      }
    },
  },
  {
    id: "release.freeze",
    version: 1,
    type: "operation",
    async run(env) {
      const snapshotId = requireContextSnapshot(env);
      const targetId = env.resolved["target"] ?? env.context.targetId;
      if (targetId === null || targetId === undefined) {
        return failure("release.freeze requires context.targetId (or a 'target' binding)");
      }
      const releaseProfileId = (env.context.releaseProfileId ?? "submission") as ReleaseProfileId;
      if (!["draft", "review", "submission"].includes(releaseProfileId)) {
        return failure(`releaseProfileId ${JSON.stringify(releaseProfileId)} is not draft|review|submission`);
      }
      const out = await freezeRelease(releaseDeps(env), {
        snapshotId,
        targetId,
        releaseProfileId,
      });
      return {
        kind: "success",
        result: {
          releaseId: out.releaseId,
          releaseProfileId,
          candidatePaths: out.plan.candidatePaths.length,
          requiredCheckIds: out.plan.requiredCheckIds,
          requiredApprovals: out.plan.requiredApprovals,
        },
        contextUpdates: { releaseId: out.releaseId, releaseProfileId },
        jobId: out.jobId,
      };
    },
  },
  {
    id: "quality.run-release-checks",
    version: 1,
    type: "operation",
    async run(env) {
      const artifactId = env.resolved["artifact"] ?? env.context.pdfArtifactId;
      if (artifactId === null || artifactId === undefined) {
        return failure("quality.run-release-checks requires context.pdfArtifactId — build must run first");
      }
      const out = await runReleaseChecks(
        {
          store: env.store,
          blobs: env.blobs,
          ctx: env.ctx,
          scope: env.scope,
          jobs: env.buildService.jobService(),
          hostPolicy: hostPolicyOf(env.repoRoot),
          repoRoot: env.repoRoot,
        },
        {
          artifactId,
          rulesetId: "release",
          releaseProfileId: env.context.releaseProfileId as ReleaseProfileId | undefined,
          ...(env.context.baselineArtifactId !== undefined
            ? { baselineArtifactId: env.context.baselineArtifactId }
            : {}),
        },
      );
      const contextUpdates: Partial<WorkflowContext> = {
        checkReportArtifactId: out.reportArtifactId,
      };
      const summary = {
        reportArtifactId: out.reportArtifactId,
        blockingIds: out.report.blockingIds,
        missingReviewIds: out.report.missingReviewIds,
        results: out.report.results.map((r) => ({
          checkId: r.checkId,
          status: r.status,
          severity: r.severity,
        })),
      };
      if (out.report.blockingIds.length > 0) {
        return failure(
          `release checks have blocking outcomes: ${out.report.blockingIds.join(", ")}`,
          { result: summary, contextUpdates, jobId: out.jobId },
        );
      }
      return { kind: "success", result: summary, contextUpdates, jobId: out.jobId };
    },
  },
  {
    id: "gate.all-page-review",
    version: 1,
    type: "gate",
    run(env) {
      const artifactId = env.resolved["artifact"] ?? env.context.pdfArtifactId;
      if (artifactId === null || artifactId === undefined) {
        return failure("gate.all-page-review requires context.pdfArtifactId");
      }
      const policy = hostPolicyOf(env.repoRoot);
      const coverage = pageReviewCoverage(env.store, env.scope, artifactId);
      if (coverage.pagesFlagged.length > 0) {
        return failure(
          `reviewer(s) flagged page(s) ${coverage.pagesFlagged.join(",")} of pdf ${artifactId} — a flagged page is a defect, not a missing review`,
        );
      }
      if (coverage.pagesTotal === 0) {
        // No page images exist — either the renderer is unavailable (the
        // check report says so) or render never ran. Either way there is
        // nothing to review; block rather than wave through.
        return failure(
          `no rendered page images exist for pdf ${artifactId} — visual review has nothing to approve`,
        );
      }
      const requireAll = policy?.requireAllReleasePagesReviewed === true;
      if (coverage.pagesUnreviewed.length > 0 && requireAll) {
        // Waits, not fails: hosts submit reviews via the review channel
        // (latexwb review …) then resume the workflow — the gate re-reads
        // the reviews table at that moment.
        return {
          kind: "waiting-approval",
          request: {
            kind: "approval",
            action: "human.review",
            description:
              `${coverage.pagesUnreviewed.length}/${coverage.pagesTotal} page(s) of pdf ${artifactId} ` +
              `are unreviewed (pages ${coverage.pagesUnreviewed.join(",")}); submit verdicts via ` +
              `'latexwb review --artifact <page-image-id> --verdict approved|flagged' then resume`,
          },
        };
      }
      return {
        kind: "success",
        result: {
          pagesTotal: coverage.pagesTotal,
          pagesReviewed: coverage.pagesReviewed,
          pagesUnreviewed: coverage.pagesUnreviewed,
          requireAll,
        },
      };
    },
  },
  {
    id: "release.prepare-whitelist",
    version: 1,
    type: "operation",
    async run(env) {
      const releaseId = requireContextRelease(env);
      const out = await stageWhitelist(releaseDeps(env), { releaseId });
      return {
        kind: "success",
        result: {
          whitelistArtifactId: out.whitelistArtifactId,
          whitelistDigest: out.whitelistDigest,
        },
        contextUpdates: {
          whitelistArtifactId: out.whitelistArtifactId,
          whitelistDigest: out.whitelistDigest,
        },
        jobId: out.jobId,
      };
    },
  },
  {
    id: "gate.release-approval",
    version: 1,
    type: "gate",
    run(env) {
      const releaseId = requireContextRelease(env);
      const release = env.store.getRelease(env.scope, releaseId) as Row;
      const snapshotId = release["snapshot_id"] as string;
      const targetId = release["target_id"] as string;
      const scopeDigest = releaseApprovalDigest(releaseId, snapshotId, targetId, env.store, env.scope);
      const now = utcNowIso();
      env.store.expireApprovals(env.scope, now);
      const usable = env.store.findUsableApproval(
        env.scope, RELEASE_PACKAGE_ACTION, scopeDigest, snapshotId, env.ctx.policyId, now,
      );
      if (usable !== null) {
        return {
          kind: "success",
          result: { releaseId, approvalId: usable["approval_id"], scopeDigest },
        };
      }
      const grants = env.store
        .listApprovals(env.scope)
        .filter((a) => (a["scope_digest"] as string) === scopeDigest);
      const denied = grants.some((g) => ["revoked", "expired"].includes(g["state"] as string));
      if (denied) {
        return failure(
          `approval for release ${releaseId} exists but none is usable (revoked or expired)`,
        );
      }
      return {
        kind: "waiting-approval",
        request: {
          kind: "approval",
          action: RELEASE_PACKAGE_ACTION,
          scopeDigest,
          description:
            `release ${releaseId} needs a host grant for action '${RELEASE_PACKAGE_ACTION}' ` +
            `bound to digest ${scopeDigest.slice(0, 12)}… — grant via 'latexwb approve ` +
            `--action ${RELEASE_PACKAGE_ACTION} --digest ${scopeDigest}' then resume`,
        },
      };
    },
  },
  {
    id: "release.package-staging",
    version: 1,
    type: "operation",
    async run(env) {
      const releaseId = requireContextRelease(env);
      const out = await stagePackage(releaseDeps(env), { releaseId });
      return {
        kind: "success",
        result: {
          sourceZipArtifactId: out.sourceZipArtifactId,
          packageManifestArtifactId: out.packageManifestArtifactId,
        },
        contextUpdates: {
          sourceZipArtifactId: out.sourceZipArtifactId,
          packageManifestArtifactId: out.packageManifestArtifactId,
        },
        jobId: out.jobId,
      };
    },
  },
  {
    id: "release.rebuild-package",
    version: 1,
    type: "operation",
    async run(env) {
      const releaseId = requireContextRelease(env);
      const zipArtifactId = env.context.sourceZipArtifactId;
      const pdfArtifactId = env.resolved["artifact"] ?? env.context.pdfArtifactId;
      if (zipArtifactId === undefined || pdfArtifactId === null || pdfArtifactId === undefined) {
        return failure(
          "release.rebuild-package requires context.sourceZipArtifactId and context.pdfArtifactId",
        );
      }
      const release = env.store.getRelease(env.scope, releaseId) as Row;
      const target = JSON.parse(
        (env.store.getTarget(env.scope, release["target_id"] as string) as Row)["config_json"] as string,
      ) as Target;
      const out = await rebuildPackage(releaseDeps(env), {
        releaseId,
        snapshotId: release["snapshot_id"] as string,
        target,
        zipArtifactId,
        pdfArtifactId,
      });
      if (!out.verified) {
        return failure(
          `clean-room rebuild did not reproduce the staged pdf: ${out.detail}`,
          {
            result: { rebuildJobId: out.rebuildJobId, expectedSha256: out.expectedSha256, actualSha256: out.actualSha256 },
            contextUpdates: { rebuildJobId: out.rebuildJobId },
            jobId: out.rebuildJobId,
          },
        );
      }
      return {
        kind: "success",
        result: {
          rebuildJobId: out.rebuildJobId,
          verified: true,
          sha256: out.expectedSha256,
          detail: out.detail,
        },
        contextUpdates: { rebuildJobId: out.rebuildJobId },
        jobId: out.rebuildJobId,
      };
    },
  },
  {
    id: "release.finalize",
    version: 1,
    type: "operation",
    async run(env) {
      const releaseId = requireContextRelease(env);
      const pdfArtifactId = env.resolved["artifact"] ?? env.context.pdfArtifactId;
      if (pdfArtifactId === null || pdfArtifactId === undefined) {
        return failure("release.finalize requires context.pdfArtifactId");
      }
      const out = await finalizeRelease(releaseDeps(env), {
        releaseId,
        pdfArtifactId,
        ...(env.context.sourceZipArtifactId !== undefined
          ? { sourceZipArtifactId: env.context.sourceZipArtifactId }
          : {}),
        ...(env.context.rebuildJobId !== undefined
          ? { rebuildJobId: env.context.rebuildJobId }
          : {}),
        ...(env.context.baselineArtifactId !== undefined
          ? { baselineArtifactId: env.context.baselineArtifactId }
          : {}),
      });
      const result = out.result;
      if (result.status === "blocked") {
        return failure(
          `release ${releaseId} finalized blocked: ${result.blockingCodes.join(", ")}`,
          { result, jobId: out.jobId },
        );
      }
      return { kind: "success", result, jobId: out.jobId };
    },
  },
];

/** Agent operations: the engine never calls a model — each yields a typed
 * waiting-input request the host answers via resumeWorkflow. */
function agentWaiting(operationId: string, description: string): OperationImpl {
  return {
    id: operationId,
    version: 1,
    type: "agent",
    run(env) {
      return {
        kind: "waiting-input",
        request: {
          ...(operationId === "agent.plan-document"
            ? { kind: "host-input" as const }
            : {
                kind: "patch-proposal" as const,
                inputField: "patchId",
                baseSnapshotId: headSnapshotId(env.store, env.scope),
              }),
          description,
        },
      };
    },
  };
}

const AGENT_IMPLS: OperationImpl[] = [
  agentWaiting(
    "agent.propose-minimal-repair",
    "propose a minimal patch fixing the failing build's first diagnostic; supply a patchId based on the current head",
  ),
  agentWaiting(
    "agent.propose-revision",
    "propose a revision patch; supply a patchId based on the current head",
  ),
  agentWaiting(
    "agent.propose-asset-insertion",
    "propose a patch inserting an approved asset; supply a patchId based on the current head",
  ),
  agentWaiting(
    "agent.propose-migration",
    "propose a venue-migration patch; supply a patchId based on the current head",
  ),
  agentWaiting(
    "agent.plan-document",
    "supply the document plan the host computed (structure + evidence requirements)",
  ),
];

export const OPERATIONS: ReadonlyMap<string, OperationImpl> = new Map(
  [...OPERATION_IMPLS, ...AGENT_IMPLS].map((o) => [o.id, o]),
);

/**
 * Load-time consistency assertion, both directions. Every registry id has a
 * real impl or an explicit unsupportedReason; every impl id exists in the
 * JSON registry with a matching type. Drift is a hard error at startup.
 */
export function assertRegistryConsistency(repoRoot: string): void {
  const registry = loadOperationRegistry(repoRoot);
  const registryIds = new Set(registry.map((o) => o.id));
  for (const entry of registry) {
    const impl = OPERATIONS.get(entry.id);
    if (impl === undefined && entry.unsupportedReason === undefined) {
      throw new WorkbenchError(
        ERROR_CODES.INVALID_REQUEST,
        `operation-registry drift: ${entry.id} has neither an implementation nor an unsupportedReason`,
      );
    }
    if (impl !== undefined && impl.type !== entry.type) {
      throw new WorkbenchError(
        ERROR_CODES.INVALID_REQUEST,
        `operation-registry drift: ${entry.id} type ${impl.type} != registry type ${entry.type}`,
      );
    }
  }
  for (const id of OPERATIONS.keys()) {
    if (!registryIds.has(id)) {
      throw new WorkbenchError(
        ERROR_CODES.INVALID_REQUEST,
        `operation-registry drift: implementation ${id} is not in the JSON registry`,
      );
    }
  }
}

/** Run one registry operation; unsupported ids throw NOT_IMPLEMENTED. */
export function unsupportedOperationReason(repoRoot: string, operationId: string): string {
  const entry: OperationRegistryEntry | undefined = loadOperationRegistry(repoRoot).find(
    (o) => o.id === operationId,
  );
  return entry?.unsupportedReason ?? "no implementation registered";
}

export function assertOperationSupported(repoRoot: string, operationId: string): OperationImpl {
  const impl = OPERATIONS.get(operationId);
  if (impl === undefined) {
    throw new NotImplementedError(
      `operation.${operationId}`,
      unsupportedOperationReason(repoRoot, operationId),
    );
  }
  return impl;
}
