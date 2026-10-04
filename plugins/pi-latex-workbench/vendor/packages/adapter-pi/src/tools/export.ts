/**
 * latex_export — LIVE (M4): `prepare` computes and persists the ReleasePlan
 * (candidate source whitelist + required checks/approvals) for a frozen
 * (snapshot, target); `package` freezes a release for the input tuple, then
 * runs the full pipeline — checks, whitelist, approval gate, deterministic
 * staging, clean-room rebuild, finalize — and returns the ReleaseResult.
 *
 * package does not invent a pdf: it resolves the latest compiled pdf artifact
 * of that snapshot (same rule as baseline.capture). A missing build, a missing
 * approval grant or unreviewed pages all surface as a "blocked" ReleaseResult
 * — the envelope still validates, and blockingCodes name exactly what failed.
 */
import type { BuildResult, ExportInput } from "@latexwb/contracts";
import { ERROR_CODES, WorkbenchError } from "@latexwb/contracts";
import {
  freezeRelease,
  packageRelease,
  prepareRelease,
  type ReleaseProfileId,
} from "@latexwb/core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Scope, WorkbenchStore } from "@latexwb/storage";
import type { WorkbenchSession } from "../session.ts";
import { ExportParams } from "../schemas.ts";
import { jobArtifactRefs, runTool, toAgentResult, type DispatchOutcome } from "./common.ts";

/** The latest compiled pdf artifact of a snapshot+target (latest successful build). */
function latestCompiledPdf(
  store: WorkbenchStore,
  scope: Scope,
  snapshotId: string,
  targetId: string,
): string | null {
  return (
    store
      .listJobs(scope, { limit: 500 })
      .filter(
        (r) =>
          (r["state"] as string) === "succeeded" &&
          (r["action"] as string) === "build.run" &&
          (r["snapshot_id"] as string | null) === snapshotId,
      )
      .map((r) => {
        try {
          const br = (
            JSON.parse((r["result_json"] as string) ?? "{}") as { buildResult?: BuildResult }
          ).buildResult;
          if (br === undefined || br.status !== "compiled" || br.targetId !== targetId) {
            return null;
          }
          return br.pdfArtifactId;
        } catch {
          return null;
        }
      })
      .filter((id): id is string => id !== null)
      .at(-1) ?? null
  );
}

async function dispatch(
  session: WorkbenchSession,
  input: ExportInput,
  scope: Scope,
): Promise<DispatchOutcome> {
  const deps = {
    store: session.store,
    blobs: session.blobs,
    ctx: session.requestContextFor(["release.create", "project.read", "artifact.read", "data.render"]),
    scope,
    repoRoot: session.config.repoRoot,
    hostPolicy: session.hostPolicy(),
    buildService: session.buildService,
    jobs: session.buildService.jobService(),
  };
  switch (input.action) {
    case "prepare": {
      const out = await prepareRelease(deps, {
        snapshotId: input.snapshotId,
        targetId: input.targetId,
        releaseProfileId: input.releaseProfileId as ReleaseProfileId,
      });
      return {
        data: out.plan,
        snapshotId: input.snapshotId,
        artifacts: jobArtifactRefs(session.store, scope, out.jobId),
      };
    }
    case "package": {
      // A frozen releaseId names the release to package — the approval
      // digest the host granted binds to it. Without one we freeze a fresh
      // release for the input tuple (any grant must then target the digest
      // of THIS new release, which package reports back).
      let releaseId: string | undefined = input.releaseId;
      let pdfArtifactId: string | null;
      if (releaseId !== undefined) {
        const row = session.store.getRelease(scope, releaseId);
        if (row === null) {
          throw new WorkbenchError(
            ERROR_CODES.NOT_FOUND,
            `release ${releaseId} not found in this project scope`,
          );
        }
        const manifest = JSON.parse(row["manifest_json"] as string) as {
          releaseProfileId?: string;
          pdfArtifactId?: string;
        };
        if (
          manifest.releaseProfileId !== undefined &&
          manifest.releaseProfileId !== input.releaseProfileId
        ) {
          throw new WorkbenchError(
            ERROR_CODES.INVALID_REQUEST,
            `release ${releaseId} was frozen under profile "${manifest.releaseProfileId}" — ` +
              `input declares "${input.releaseProfileId}"`,
          );
        }
        const frozenSnap = row["snapshot_id"] as string;
        const frozenTarget = row["target_id"] as string;
        if (frozenSnap !== input.snapshotId || frozenTarget !== input.targetId) {
          throw new WorkbenchError(
            ERROR_CODES.INVALID_REQUEST,
            `release ${releaseId} was frozen on (snapshot ${frozenSnap}, target ${frozenTarget}) — ` +
              `input declares (${input.snapshotId}, ${input.targetId}); approvals bind to the frozen tuple`,
          );
        }
        pdfArtifactId =
          manifest.pdfArtifactId ??
          latestCompiledPdf(session.store, scope, input.snapshotId, input.targetId);
      } else {
        pdfArtifactId = latestCompiledPdf(
          session.store, scope, input.snapshotId, input.targetId,
        );
      }
      if (pdfArtifactId === null) {
        throw new WorkbenchError(
          ERROR_CODES.INVALID_REQUEST,
          `no compiled pdf artifact exists for (snapshot ${input.snapshotId}, target ${input.targetId}) — run latex_build first`,
        );
      }
      if (releaseId === undefined) {
        const frozen = await freezeRelease(deps, {
          snapshotId: input.snapshotId,
          targetId: input.targetId,
          releaseProfileId: input.releaseProfileId as ReleaseProfileId,
          pdfArtifactId,
        });
        releaseId = frozen.releaseId;
      }
      const out = await packageRelease(deps, { releaseId, pdfArtifactId });
      return {
        data: out.result,
        snapshotId: input.snapshotId,
        // A "blocked" release is a completed pipeline run, not a tool
        // execution block — the envelope stays completed and the data names
        // the blocking codes.
        artifacts: jobArtifactRefs(session.store, scope, out.jobId),
      };
    }
  }
}

export function exportTool(session: WorkbenchSession): ToolDefinition {
  return {
    name: "latex_export",
    label: "LaTeX Export",
    description:
      "Release pipeline for the bound project: prepare computes the frozen " +
      "ReleasePlan (whitelist + required checks/approvals); package runs " +
      "checks → whitelist → approval gate → deterministic source zip → " +
      "clean-room rebuild → finalize. Pass releaseId to package an " +
      "already-frozen release (the digest a host approval binds to); omit " +
      "it to freeze a fresh release for the input tuple. Missing reviews, " +
      "grants or a rebuild mismatch produce a 'blocked' ReleaseResult " +
      "naming the codes.",
    promptSnippet: "Formal release only: prepare a release plan or package a reviewed, host-approved release",
    parameters: ExportParams,
    async execute(_toolCallId, params) {
      const envelope = await runTool(session, "ExportInput", params, (input: ExportInput, scope) =>
        dispatch(session, input, scope),
      );
      return toAgentResult(envelope);
    },
  };
}
