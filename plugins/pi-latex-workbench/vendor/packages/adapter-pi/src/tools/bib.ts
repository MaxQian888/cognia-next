/**
 * latex_bib — LIVE (M3): real BibTeX audit, policy-gated metadata lookup,
 * and evidence-bound import proposals. `lookup` answers from the snapshot's
 * own .bib files plus providers the host policy admits (crossref when
 * listed; its response bytes are persisted as evidence either way).
 * `propose-import` produces a real PatchProposal or a null proposal with
 * an explicit noChange diagnostic — never a fabricated patch.
 */
import {
  ERROR_CODES,
  WorkbenchError,
  type BibInput,
  type Diagnostic,
} from "@latexwb/contracts";
import {
  auditBibliography,
  lookupCitations,
  proposeBibliographyImport,
} from "@latexwb/core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Scope } from "@latexwb/storage";
import type { WorkbenchSession } from "../session.ts";
import { BibParams } from "../schemas.ts";
import { jobArtifactRefs, runTool, toAgentResult, type DispatchOutcome } from "./common.ts";

function noChangeDiagnostic(message: string): Diagnostic {
  return {
    code: "NO_CANDIDATES",
    severity: "info",
    message,
    source: null,
    page: null,
    causeId: null,
    evidenceArtifactIds: [],
    rawLogRange: null,
    confidence: "certain",
  };
}

async function dispatch(
  session: WorkbenchSession,
  input: BibInput,
  scope: Scope,
): Promise<DispatchOutcome> {
  const { store, blobs } = session;
  switch (input.action) {
    case "lookup": {
      const snapshotId = session.headSnapshotId(scope);
      if (snapshotId === null) {
        throw new WorkbenchError(
          ERROR_CODES.NOT_FOUND,
          `project ${scope.projectId} has no head snapshot`,
        );
      }
      const out = await lookupCitations(
        {
          store,
          blobs,
          ctx: session.requestContextFor(["metadata.lookup", "project.read"]),
          scope,
          hostPolicy: session.hostPolicy(),
          repoRoot: session.config.repoRoot,
        },
        {
          snapshotId,
          localCorpus: "project",
          ...("query" in input ? { query: input.query } : { identifier: input.identifier }),
        },
      );
      return {
        data: out.result,
        snapshotId,
        artifacts: jobArtifactRefs(store, scope, out.jobId),
      };
    }
    case "audit": {
      const out = await auditBibliography(
        {
          store,
          blobs,
          ctx: session.requestContextFor(["project.read"]),
          scope,
        },
        { snapshotId: input.snapshotId, bibPaths: input.bibPaths },
      );
      return {
        data: out.audit,
        snapshotId: input.snapshotId,
        artifacts: jobArtifactRefs(store, scope, out.jobId),
      };
    }
    case "propose-import": {
      const out = await proposeBibliographyImport(
        {
          store,
          blobs,
          ctx: session.requestContextFor(["project.write", "project.read"]),
          scope,
        },
        {
          baseSnapshotId: input.baseSnapshotId,
          bibPath: input.bibPath,
          candidateIds: input.candidateIds,
        },
      );
      if (out.proposal === null) {
        return {
          data: null,
          snapshotId: input.baseSnapshotId,
          diagnostics: [
            noChangeDiagnostic(
              `no importable candidates remained (${out.skipped.join("; ") || "none skipped"}${
                out.warnings.length > 0 ? `; warnings: ${out.warnings.join("; ")}` : ""
              })`,
            ),
          ],
        };
      }
      return { data: out.proposal, snapshotId: input.baseSnapshotId };
    }
  }
}

export function bibTool(session: WorkbenchSession): ToolDefinition {
  return {
    name: "latex_bib",
    label: "LaTeX Bibliography",
    description:
      "Audit citations against the snapshot's .bib files (real parsing: " +
      "missing keys, duplicates, syntax errors), look up metadata through " +
      "approved providers (project .bib corpus, plus crossref when host " +
      "policy admits it — every lookup persists provider evidence), and " +
      "propose a real import patch from persisted candidates.",
    promptSnippet: "Audit .bib citations, look up verified reference metadata, propose bibliography imports",
    promptGuidelines: ["Never invent bibliography entries: add references only from latex_bib lookup candidates or sources the user supplied, and say when metadata could not be verified."],
    parameters: BibParams,
    async execute(_toolCallId, params) {
      const envelope = await runTool(session, "BibInput", params, (input: BibInput, scope) =>
        dispatch(session, input, scope),
      );
      return toAgentResult(envelope);
    },
  };
}
