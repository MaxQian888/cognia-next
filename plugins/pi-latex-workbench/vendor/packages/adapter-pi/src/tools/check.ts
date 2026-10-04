/**
 * latex_check — LIVE (M3 data-assets ruleset; M4 release ruleset; draft
 * source lint). `run` dispatches on rulesetId: "data-assets" re-renders
 * generated assets and compares byte-for-byte; "release" runs the full
 * release suite against a compiled pdf (build lineage, references, protected
 * content, anonymization, render-backed page/font checks, review coverage);
 * "draft" lints the sources and build log behind any compiled pdf
 * (references, labels, citations, floats, placeholders, typography) and
 * gates nothing. An unknown rulesetId is an error — never an
 * all-unsupported report. `report` reads a persisted CheckReport back.
 */
import type { CheckInput } from "@latexwb/contracts";
import {
  runDataAssetChecks,
  runDraftChecks,
  runReleaseChecks,
  readCheckReport,
} from "@latexwb/core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Scope } from "@latexwb/storage";
import type { WorkbenchSession } from "../session.ts";
import { CheckParams } from "../schemas.ts";
import { jobArtifactRefs, runTool, toAgentResult, type DispatchOutcome } from "./common.ts";

async function dispatch(
  session: WorkbenchSession,
  input: CheckInput,
  scope: Scope,
): Promise<DispatchOutcome> {
  const { store, blobs } = session;
  switch (input.action) {
    case "run": {
      const out =
        input.rulesetId === "release"
          ? await runReleaseChecks(
              {
                store,
                blobs,
                ctx: session.requestContextFor(["data.render", "project.read", "artifact.read"]),
                scope,
                hostPolicy: session.hostPolicy(),
                repoRoot: session.config.repoRoot,
              },
              {
                artifactId: input.artifactId,
                rulesetId: input.rulesetId,
                ...(input.baselineArtifactId !== undefined
                  ? { baselineArtifactId: input.baselineArtifactId }
                  : {}),
              },
            )
          : input.rulesetId === "draft"
            ? await runDraftChecks(
                {
                  store,
                  blobs,
                  ctx: session.requestContextFor(["data.render", "project.read", "artifact.read"]),
                  scope,
                  hostPolicy: session.hostPolicy(),
                  repoRoot: session.config.repoRoot,
                },
                {
                  artifactId: input.artifactId,
                  rulesetId: input.rulesetId,
                  ...(input.baselineArtifactId !== undefined
                    ? { baselineArtifactId: input.baselineArtifactId }
                    : {}),
                },
              )
            : await runDataAssetChecks(
                {
                  store,
                  blobs,
                  ctx: session.requestContextFor(["data.render", "project.read", "artifact.read"]),
                  scope,
                  hostPolicy: session.hostPolicy(),
                },
                {
                  artifactId: input.artifactId,
                  rulesetId: input.rulesetId,
                  ...(input.baselineArtifactId !== undefined
                    ? { baselineArtifactId: input.baselineArtifactId }
                    : {}),
                },
              );
      return {
        data: out.report,
        snapshotId: out.report.snapshotId,
        artifacts: jobArtifactRefs(store, scope, out.jobId),
      };
    }
    case "report": {
      const report = readCheckReport(
        {
          store,
          blobs,
          ctx: session.requestContextFor(["project.read", "artifact.read"]),
          scope,
          hostPolicy: session.hostPolicy(),
        },
        { reportArtifactId: input.reportArtifactId },
      );
      return { data: report, snapshotId: report.snapshotId };
    }
  }
}

export function checkTool(session: WorkbenchSession): ToolDefinition {
  return {
    name: "latex_check",
    label: "LaTeX Check",
    description:
      "Run 'draft' source lint on any compiled PDF (refs, labels, citations, " +
      "floats, placeholders, typography, build log; gates nothing), 'release' " +
      "checks on a compiled PDF, or 'data-assets' checks on a generated " +
      "artifact; read persisted reports with action 'report'. Release checks " +
      "include human review coverage: needs-review does not mean an ordinary " +
      "draft failed to compile. These are the only supported rulesets; " +
      "unverifiable checks never report pass.",
    promptSnippet: "Lint a compiled draft (rulesetId 'draft'), run release/data-assets checks, or read a report",
    parameters: CheckParams,
    async execute(_toolCallId, params) {
      const envelope = await runTool(session, "CheckInput", params, (input: CheckInput, scope) =>
        dispatch(session, input, scope),
      );
      return toAgentResult(envelope);
    },
  };
}
