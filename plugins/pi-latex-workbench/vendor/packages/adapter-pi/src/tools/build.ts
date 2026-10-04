/**
 * latex_build — run / status / cancel against the committed BuildService
 * and JobService. Results are the real JobResult objects the services
 * produce, including diagnostics, artifact ids and cache status.
 */
import {
  ERROR_CODES,
  WorkbenchError,
  type BuildInput,
  type JobResult,
  type ToolError,
} from "@latexwb/contracts";
import type { JobView } from "@latexwb/core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Scope } from "@latexwb/storage";
import type { WorkbenchSession } from "../session.ts";
import { BuildParams } from "../schemas.ts";
import { jobArtifactRefs, runTool, toAgentResult, type DispatchOutcome } from "./common.ts";

function jobResultOf(session: WorkbenchSession, scope: Scope, job: JobView): JobResult {
  const artifactIds = session.store
    .listArtifactsByJob(scope, job.jobId)
    .map((a) => a["artifact_id"] as string);
  let buildResult: JobResult["buildResult"] = null;
  if (job.resultJson !== null) {
    try {
      buildResult =
        (JSON.parse(job.resultJson) as { buildResult?: JobResult["buildResult"] }).buildResult ??
        null;
    } catch {
      buildResult = null;
    }
  }
  const error: ToolError | null =
    job.errorCode === null
      ? null
      : {
          code: job.errorCode,
          message: `job ended in state ${job.state}`,
          retryable: job.state === "lost",
        };
  return {
    kind: "job-status",
    jobId: job.jobId,
    state: job.state,
    snapshotId: job.snapshotId,
    attempt: job.attempt,
    resultArtifactIds: artifactIds,
    error,
    buildResult,
  };
}

async function dispatch(
  session: WorkbenchSession,
  input: BuildInput,
  scope: Scope,
): Promise<DispatchOutcome> {
  const svc = session.buildService;
  const jobs = svc.jobService();
  switch (input.action) {
    case "run": {
      // "default" selects the auto-resolved build root when no persisted
      // target carries that id; any other unknown id fails NOT_FOUND inside
      // resolveTarget rather than silently picking one.
      const persisted = session.store
        .listTargets(scope)
        .map((r) => r["target_id"] as string);
      const targetId =
        input.targetId === "default" && !persisted.includes("default")
          ? null
          : input.targetId;
      const outcome = await svc.build(scope, session.requestContext(), {
        snapshotId: input.snapshotId,
        targetId,
        clean: input.clean === true,
      });
      return { data: outcome.jobResult, snapshotId: outcome.jobResult.snapshotId,
        artifacts: jobArtifactRefs(session.store, scope, outcome.jobResult.jobId) };
    }
    case "status": {
      const job = jobs.get(scope, input.jobId);
      if (job === null) {
        throw new WorkbenchError(ERROR_CODES.NOT_FOUND, `job ${input.jobId} not found`);
      }
      return { data: jobResultOf(session, scope, job), snapshotId: job.snapshotId,
        artifacts: jobArtifactRefs(session.store, scope, job.jobId) };
    }
    case "cancel": {
      const job = jobs.get(scope, input.jobId);
      if (job === null) {
        throw new WorkbenchError(ERROR_CODES.NOT_FOUND, `job ${input.jobId} not found`);
      }
      svc.cancel(scope, input.jobId);
      const after = jobs.get(scope, input.jobId);
      return {
        data: after === null ? null : jobResultOf(session, scope, after),
        snapshotId: job.snapshotId,
      };
    }
  }
}

export function buildTool(session: WorkbenchSession): ToolDefinition {
  return {
    name: "latex_build",
    label: "LaTeX Build",
    description:
      "Run a real compile of the bound project (Tectonic via the committed " +
      "build service), query job status, or cancel a job. Returns the real " +
      "JobResult including diagnostics and artifact ids. targetId is a " +
      "registered target ID, not a filename. If inspection reports no " +
      "registered targets, use targetId 'default' to auto-resolve the root; " +
      "an ambiguous root returns a diagnostic rather than guessing.",
    promptSnippet: "Compile a snapshot/target, inspect a build job, or cancel it",
    promptGuidelines: ["After latex_build, check data.buildResult.status and its diagnostics. Tool execution completed alone does not mean the document compiled."],
    parameters: BuildParams,
    async execute(_toolCallId, params) {
      const envelope = await runTool(session, "BuildInput", params, (input: BuildInput, scope) =>
        dispatch(session, input, scope),
      );
      return toAgentResult(envelope);
    },
  };
}
