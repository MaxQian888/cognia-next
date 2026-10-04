/**
 * latex_figure — LIVE (M3): generates table/plot/diagram assets from real
 * snapshot data through the trusted recipe registry, then compiles the
 * output with the real Tectonic runner. The returned artifact ids are
 * persisted rows; a failed compile surfaces as real diagnostics on the
 * envelope plus a succeeded job whose compileProof says "failed" — the
 * .tex, mapping and log artifacts are still published.
 */
import type { FigureInput, Diagnostic } from "@latexwb/contracts";
import { generateDataAsset } from "@latexwb/core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Scope } from "@latexwb/storage";
import type { WorkbenchSession } from "../session.ts";
import { FigureParams } from "../schemas.ts";
import { jobArtifactRefs, runTool, toAgentResult, type DispatchOutcome } from "./common.ts";

async function dispatch(
  session: WorkbenchSession,
  input: FigureInput,
  scope: Scope,
): Promise<DispatchOutcome> {
  const { store, blobs } = session;
  const deps = {
    store,
    blobs,
    ctx: session.requestContextFor(["data.render", "project.read", "artifact.read"]),
    scope,
    repoRoot: session.config.repoRoot,
    hostPolicy: session.hostPolicy(),
    presetsDir: session.presetsDir(),
  };
  const out = await generateDataAsset(deps, input);
  const diagnostics: Diagnostic[] = [...out.diagnostics];
  if (out.compileProof !== "compiled") {
    diagnostics.unshift({
      code: out.compileProof === "failed" ? "COMPILE_FAILED" : "RUNTIME_UNAVAILABLE",
      severity: out.compileProof === "failed" ? "error" : "warning",
      message:
        out.compileProof === "failed"
          ? "generated asset did not compile — the .tex, mapping and log artifacts are published; see diagnostics"
          : "compile proof skipped: the toolchain runner was unavailable",
      source: null,
      page: null,
      causeId: null,
      evidenceArtifactIds: [],
      rawLogRange: null,
      confidence: "certain",
    });
  }
  return {
    data: out.result,
    snapshotId: input.snapshotId,
    diagnostics,
    artifacts: jobArtifactRefs(store, scope, out.jobId),
  };
}

export function figureTool(session: WorkbenchSession): ToolDefinition {
  return {
    name: "latex_figure",
    label: "LaTeX Figure",
    description:
      "Generate a table (booktabs), plot (PGFPlots) or diagram (TikZ) from a " +
      "snapshot data asset via the approved recipe registry, compile the " +
      "result with the real toolchain, and return the persisted artifact " +
      "ids plus a numeric-mapping artifact for later checks.",
    promptSnippet: "Generate a booktabs table, PGFPlots plot or TikZ diagram from a project data asset",
    parameters: FigureParams,
    async execute(_toolCallId, params) {
      const envelope = await runTool(session, "FigureInput", params, (input: FigureInput, scope) =>
        dispatch(session, input, scope),
      );
      return toAgentResult(envelope);
    },
  };
}
