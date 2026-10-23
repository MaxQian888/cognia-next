/**
 * Shapes shared by the latex-kit analyzers.
 *
 * These mirror the corresponding @latexwb/contracts types field-for-field
 * (contracts' generated `ProtectedChange`, `TextEdit` byte ranges, and the
 * `CheckResult` status/severity unions) so values flow between the two
 * without conversion — TypeScript's structural typing makes them
 * interchangeable. latex-kit must stay self-contained (it is vendored into
 * other products), so it declares them here instead of importing contracts.
 * Keep them in sync with packages/contracts/schemas when those change.
 */

/** A half-open [startByte, endByte) range of UTF-8 byte offsets. */
export interface ByteRange {
  startByte: number;
  endByte: number;
}

export type ProtectedCategory =
  | "math"
  | "citation-key"
  | "label"
  | "reported-result"
  | "quote"
  | "template"
  | "raw-asset"
  | "unknown-macro";

export type ProtectedChangeKind = "added" | "modified" | "removed";

/** One protected-content change found by `analyzeProtectedChanges`. */
export interface ProtectedChange {
  path: string;
  category: ProtectedCategory;
  change?: ProtectedChangeKind;
  before: string;
  after: string;
  reason: string;
}

/** Outcome of one draft-lint check (same union as contracts' CheckResult.status). */
export type DraftCheckStatus = "pass" | "fail" | "not-applicable" | "unsupported" | "needs-review";

/** Severity of one draft-lint check (same union as contracts' CheckResult.severity). */
export type DraftCheckSeverity = "info" | "warning" | "error";
