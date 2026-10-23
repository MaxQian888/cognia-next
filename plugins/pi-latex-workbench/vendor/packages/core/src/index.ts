export * from "./capabilities.ts";
export * from "./context.ts";
export * from "./idempotency.ts";
export * from "./audit.ts";
export * from "./scoped.ts";
export * from "./paths.ts";
export * from "./import.ts";
export * from "./snapshot.ts";
export * from "./inspect.ts";
export * from "./diagnostics.ts";
export * from "./artifacts.ts";
export * from "./jobs.ts";
export * from "./build.ts";
export * from "./project.ts";
export * from "./patch.ts";
export * from "./approvals.ts";
export * from "./budget.ts";
export * from "./materialize.ts";
export * from "./evidence.ts";
export * from "./service-job.ts";
export * from "./metadata/index.ts";
export * from "./bibliography.ts";
export * from "./csv.ts";
export * from "./recipes.ts";
export * from "./assets.ts";
export * from "./checks.ts";
export * from "./render.ts";
export * from "./review.ts";
export * from "./release.ts";
export * from "./zip.ts";
export * from "./resources.ts";
export * from "./init.ts";
export * from "./workflow-defs.ts";
export * from "./net.ts";
export * from "./venue.ts";
export * from "./operations.ts";
export * from "./workflow.ts";
// Pure LaTeX analysis lives in @latexwb/latex-kit; these names have always
// been part of @latexwb/core's public surface, so they are re-exported here.
export {
  analyzeProtectedChanges,
  classifyRole,
  collectProjectMacros,
  collectProjectUsedMacros,
  DRAFT_FINDING_CAP,
  extractProtectedSets,
  isAdditiveChange,
  lintDraftSources,
  maskComments,
  parseBibTeX,
  parseBibTeXText,
  scanCitations,
  type AnalyzeProtectedChangesOptions,
  type BibEntry,
  type BibError,
  type BibFile,
  type ByteRange,
  type CitationUse,
  type DraftLint,
  type DraftLintResult,
  type ProtectedSets,
} from "@latexwb/latex-kit";
