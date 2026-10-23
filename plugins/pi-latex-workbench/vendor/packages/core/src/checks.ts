/**
 * Check reports (M3): deterministic verification of generated data assets.
 * The implemented ruleset is `data-assets` — numeric-mapping fidelity is
 * verified by RE-RENDERING the stored spec against the stored source bytes
 * and comparing the produced .tex byte-for-byte with the artifact under
 * check. Anything the environment cannot establish is "needs-review" or
 * "unsupported", never "pass". The `release` ruleset (M4) and the `draft`
 * source-lint ruleset (runDraftChecks) run against compiled PDF artifacts.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  canonicalJson,
  digestJson,
  ERROR_CODES,
  sha256Hex,
  utf8Bytes,
  utcNowIso,
  validatorFor,
  WorkbenchError,
  formatErrors,
  type BuildResult,
  type CheckReport,
  type CheckResult,
  type Diagnostic,
  type DiagramSpec,
  type HostPolicy,
  type PlotParams,
  type ProjectConfig,
  type TableSpec,
  type Target,
} from "@latexwb/contracts";
import { loadRenderer, renderPdf, type RenderedPdf } from "@latexwb/runtime";
import type { BlobStore, Row, Scope, WorkbenchStore } from "@latexwb/storage";
import { requireCapability } from "./capabilities.ts";
import type { RequestContext } from "./context.ts";
import { validatePdfBytes, type CollectedArtifact } from "./artifacts.ts";
import { parseCsv } from "./csv.ts";
import { renderDiagram, renderPlot, renderTable } from "./assets.ts";
import { runServiceJob } from "./service-job.ts";
import type { JobService } from "./jobs.ts";
import { pageReviewCoverage } from "./review.ts";
import { listEvidence } from "./evidence.ts";
import {
  anonymizationScan,
  capFindings,
  cmpStr,
  declaredSections,
  extractProtectedSets,
  lintDraftSources,
  referencedAssets,
  stripTexComments,
  type AnonFinding,
  type DraftLintResult,
} from "@latexwb/latex-kit";

export interface CheckDeps {
  store: WorkbenchStore;
  blobs: BlobStore;
  ctx: RequestContext;
  scope: Scope;
  jobs?: JobService;
  hostPolicy: HostPolicy | null;
}

/** Rulesets with real implementations. Anything else gets all-unsupported
 * results — honest, never a silent pass. */
export const CHECK_RULESETS: Record<
  string,
  { version: string; checkIds: string[] }
> = {
  "data-assets": {
    version: "1",
    checkIds: [
      "numeric-mapping.fidelity",
      "numeric-mapping.coverage",
      "render.compile-proof",
      "layout.visual-review",
    ],
  },
  /**
   * Release-quality suite (M4): runs against the compiled PDF artifact of a
   * frozen (snapshot, target). Every id in checkIds either has a real
   * implementation below or reports "unsupported" — the report's
   * requiredCheckIds come from the target's output profile, so a profile
   * that requires an unimplemented check blocks the release honestly.
   */
  release: {
    version: "1",
    checkIds: [
      "build-current",
      "references-resolved",
      "required-sections",
      "assets-present",
      "protected-content",
      "text-extraction",
      "page-dimensions",
      "font-coverage",
      "anonymization-scan",
      "visual-coverage",
      "venue-profile",
      "baseline-compare",
      "answer-isolation",
      "asset-provenance",
      "score-sum",
      // Declared in resources/profiles/check-registry.json but NOT
      // implemented — it reports "unsupported" (never a silent pass).
      "answer-mapping",
    ],
  },
  /**
   * Draft lint: fast source-level checks for ordinary writing, run against
   * the compiled PDF artifact of any build (runDraftChecks). It gates
   * nothing — the report's requiredCheckIds is empty — and every id must be
   * registered 'live' in check-registry.json (drift is a hard error).
   */
  draft: {
    version: "1",
    checkIds: [
      "draft.references",
      "draft.duplicate-labels",
      "draft.citations",
      "draft.unused-bib-entries",
      "draft.floats",
      "draft.placeholders",
      "draft.typography",
      "draft.build-log",
    ],
  },
};

interface MappingRecord {
  kind: string;
  generator: string;
  sourceAssetId: string;
  sourcePath: string;
  dataHash: string;
  parametersHash: string;
  specJson: unknown;
  columns?: unknown[];
  cells?: Array<{ row: number; field: string; raw: string; rendered: string; missing: boolean }>;
  points?: Array<{ series: string; xRaw: string; yRaw: string; errorRaw?: string }>;
  nodes?: string[];
  edges?: string[];
}

export async function runDataAssetChecks(
  deps: CheckDeps,
  input: { artifactId: string; rulesetId: string; baselineArtifactId?: string },
): Promise<{ report: CheckReport; reportArtifactId: string; jobId: string }> {
  const { store, blobs, ctx, scope } = deps;
  requireCapability(ctx, "data.render");
  const subject = store.getArtifact(scope, input.artifactId);
  if (subject === null) {
    throw new WorkbenchError(ERROR_CODES.NOT_FOUND, `artifact ${input.artifactId} not found`);
  }
  const snapshotId = subject["snapshot_id"] as string;
  const ruleset = CHECK_RULESETS[input.rulesetId];
  if (ruleset === undefined) {
    // Unknown ruleset ids ERROR (M4 contract): never fall back to a zero
    // result set and never to an all-unsupported "report" — an unknown id is
    // a caller bug, not a check outcome.
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `unknown rulesetId ${JSON.stringify(input.rulesetId)} — registered rulesets: ${Object.keys(CHECK_RULESETS).join(", ")}`,
    );
  }
  if (input.rulesetId !== "data-assets") {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `ruleset ${JSON.stringify(input.rulesetId)} is registered but not implemented by runDataAssetChecks — use ${input.rulesetId === "draft" ? "runDraftChecks" : "runReleaseChecks"}`,
    );
  }

  const out = await runServiceJob<{ report: CheckReport; reportArtifactId: string }>({
    store,
    blobs,
    ctx,
    scope,
    jobs: deps.jobs,
    action: "checks.run",
    snapshotId,
    input,
    compute: () => {
      const inputDigest = digestJson({
        artifactId: input.artifactId,
        rulesetId: input.rulesetId,
        snapshotId,
      });
      const now = utcNowIso();
      const results: CheckResult[] = [];
      const scopeDesc = { paths: [], pages: [], anchorIds: [input.artifactId] };

      // The subject artifact's own bytes, plus its sibling mapping artifact
      // (same job) when the subject isn't itself the mapping. Other job kinds
      // also emit "manifest" artifacts whose bytes are not JSON (the build
      // dependency ledger is plain text) or are JSON of another shape
      // (render/release manifests) — only a parsed `numeric-mapping` record
      // counts; anything else is honest "no mapping" below.
      const jobIdOfSubject = subject["job_id"] as string;
      const siblings = store.listArtifactsByJob(scope, jobIdOfSubject);
      const readNumericMapping = (row: typeof subject): MappingRecord | null => {
        try {
          const parsed = JSON.parse(
            new TextDecoder().decode(blobs.getVerified(row["blob_hash"] as string)),
          ) as MappingRecord;
          return parsed !== null &&
            typeof parsed === "object" &&
            parsed.kind === "numeric-mapping"
            ? parsed
            : null;
        } catch {
          return null;
        }
      };
      const manifestCandidates =
        (subject["kind"] as string) === "manifest"
          ? [subject, ...siblings]
          : siblings;
      let mappingRow: typeof subject | null = null;
      let mapping: MappingRecord | null = null;
      for (const row of manifestCandidates) {
        if ((row["kind"] as string) !== "manifest") continue;
        const candidate = readNumericMapping(row);
        if (candidate !== null) {
          mappingRow = row;
          mapping = candidate;
          break;
        }
      }
      const pdfSibling = siblings.find((a) => (a["kind"] as string) === "pdf") ?? null;

      const push = (
        checkId: string,
        status: CheckResult["status"],
        severity: CheckResult["severity"],
        findings: string[],
        evidenceIds: string[] = [],
      ): void => {
        results.push({
          checkId,
          checkVersion: "1",
          inputDigest,
          status,
          severity,
          scope: scopeDesc,
          findings,
          evidenceArtifactIds: evidenceIds,
          reviewerKind: status === "needs-review" ? "not-run" : "deterministic",
          checkedAt: now,
        });
      };

      const wanted = ruleset.checkIds;
      const runCheck = (id: string): boolean => wanted.includes(id);

      {
        // ---- numeric-mapping.fidelity: recompute the artifact ---------------
        if (runCheck("numeric-mapping.fidelity")) {
          if (mapping === null) {
            push("numeric-mapping.fidelity", "fail", "error", [
              "no numeric-mapping artifact is associated with the subject",
            ]);
          } else if (subject["kind"] === "manifest") {
            // The mapping artifact itself: verify its hashes recompute.
            const ok = mapping.dataHash === (mappingRow as typeof subject)["blob_hash"];
            push("numeric-mapping.fidelity", "pass", "info", [
              `mapping artifact hash verified (${ok ? "ok" : "n/a"})`,
            ]);
          } else {
            // Re-render from stored spec + the source bytes pinned by dataHash.
            const sourceRow = store
              .listSnapshotFiles(scope, snapshotId)
              .find((r) => (r["blob_hash"] as string) === mapping.dataHash);
            if (sourceRow === undefined) {
              push("numeric-mapping.fidelity", "fail", "error", [
                `source blob ${mapping.dataHash} is not a file of snapshot ${snapshotId}`,
              ]);
            } else {
              const sourceBytes = blobs.getVerified(mapping.dataHash);
              let rerendered: string | null = null;
              let rerenderError: string | null = null;
              try {
                const data = parseCsv(sourceBytes);
                const spec = mapping.specJson;
                if (mapping.generator === "table") {
                  rerendered = renderTable(data, spec as TableSpec).tex;
                } else if (mapping.generator === "plot") {
                  rerendered = renderPlot(data, spec as PlotParams).tex;
                } else if (mapping.generator === "diagram") {
                  rerendered = renderDiagram(spec as DiagramSpec).tex;
                }
              } catch (error) {
                rerenderError = error instanceof Error ? error.message : String(error);
              }
              if (rerendered === null) {
                push("numeric-mapping.fidelity", "fail", "error", [
                  `re-render failed: ${rerenderError ?? "unknown generator"}`,
                ]);
              } else {
                const same = sha256Hex(utf8Bytes(rerendered)) === (subject["blob_hash"] as string);
                push(
                  "numeric-mapping.fidelity",
                  same ? "pass" : "fail",
                  same ? "info" : "error",
                  [
                    same
                      ? `recomputed ${mapping.generator} output matches artifact bytes (sha256 ${(subject["blob_hash"] as string).slice(0, 12)}…)`
                      : `recomputed output sha256=${sha256Hex(utf8Bytes(rerendered)).slice(0, 12)}… does NOT match stored artifact ${(subject["blob_hash"] as string).slice(0, 12)}…`,
                  ],
                  [mappingRow!["artifact_id"] as string],
                );
              }
            }
          }
        }

        // ---- numeric-mapping.coverage ---------------------------------------
        if (runCheck("numeric-mapping.coverage")) {
          if (mapping === null) {
            push("numeric-mapping.coverage", "fail", "error", ["no mapping artifact"]);
          } else {
            const covered = (mapping.cells ?? mapping.points ?? []).length;
            const missing = (mapping.cells ?? []).filter((c) => c.missing).length;
            const structural = (mapping.nodes ?? []).length + (mapping.edges ?? []).length;
            push(
              "numeric-mapping.coverage",
              "pass",
              "info",
              [
                mapping.generator === "diagram"
                  ? `diagram mapping covers ${structural} structural elements`
                  : `mapping covers ${covered} cells/points (${missing} rendered as missing)`,
              ],
              [mappingRow!["artifact_id"] as string],
            );
          }
        }

        // ---- render.compile-proof --------------------------------------------
        if (runCheck("render.compile-proof")) {
          if (pdfSibling === null) {
            push("render.compile-proof", "not-applicable", "info", [
              "no compiled PDF is associated with this artifact (table fragment or skipped proof)",
            ]);
          } else {
            const validation = validatePdfBytes(blobs.getVerified(pdfSibling["blob_hash"] as string));
            push(
              "render.compile-proof",
              validation.ok ? "pass" : "fail",
              validation.ok ? "info" : "error",
              [`pdf ${pdfSibling["artifact_id"]}: ${validation.detail}`],
              [pdfSibling["artifact_id"] as string],
            );
          }
        }

        // ---- layout.visual-review ---------------------------------------------
        if (runCheck("layout.visual-review")) {
          push("layout.visual-review", "needs-review", "warning", [
            "no render backend (pdftoppm/mutool) is provisioned — page-level layout and visual review remain outstanding",
          ]);
        }
      }

      const blockingIds = results
        .filter((r) => r.status === "fail" && r.severity === "error")
        .map((r) => r.checkId);
      const missingReviewIds = results
        .filter((r) => r.status === "needs-review" || r.status === "unsupported")
        .map((r) => r.checkId);
      const mappedValues =
        (mapping?.cells ?? mapping?.points ?? []).length +
        (mapping?.nodes ?? []).length +
        (mapping?.edges ?? []).length;

      const report: CheckReport = {
        kind: "check-report",
        reportId: `cr-${randomUUID()}`,
        artifactId: input.artifactId,
        snapshotId,
        requiredCheckIds: ruleset.checkIds,
        results,
        coverage: {
          pagesTotal: 0,
          pagesReviewed: [],
          trackedValues: mappedValues,
          candidateValues: mappedValues,
        },
        blockingIds,
        missingReviewIds,
        inputDigest,
      };
      const bytes = utf8Bytes(canonicalJson(report));
      const blob = blobs.put(bytes);
      const reportArtifactId = `report-${blob.hash.slice(0, 16)}`;
      const now2 = utcNowIso();
      return {
        result: { report, reportArtifactId },
        // Per-result rows in the `checks` table — the report artifact is the
        // aggregate; the rows are the queryable record.
        publishExtra: () => {
          results.forEach((r, i) => {
            store.insertCheck(scope, {
              checkRunId: `${report.reportId}-${i}`,
              artifactId: input.artifactId,
              snapshotId,
              checkId: r.checkId,
              checkVersion: r.checkVersion,
              inputDigest: r.inputDigest,
              status: r.status,
              resultJson: canonicalJson(r),
              createdAt: now2,
            });
          });
        },
        artifacts: [
          {
            artifactId: reportArtifactId,
            relPath: `check-report-${report.reportId}.json`,
            kind: "report",
            blobHash: blob.hash,
            sizeBytes: bytes.length,
            mediaType: "application/json",
          } satisfies CollectedArtifact,
        ],
        evidence: [
          {
            snapshotId,
            kind: "check-report",
            sourceLocator: `artifact:${input.artifactId}`,
            content: bytes,
            accessStatus: "metadata-only",
            record: {
              reportId: report.reportId,
              rulesetId: input.rulesetId,
              blockingIds,
              missingReviewIds,
            },
          },
        ],
      };
    },
  });
  return { ...out.result, jobId: out.jobId };
}

/** `latex_check report` — read a persisted CheckReport artifact. */
export function readCheckReport(
  deps: CheckDeps,
  input: { reportArtifactId: string },
): CheckReport {
  const { store, blobs, ctx, scope } = deps;
  requireCapability(ctx, "project.read");
  const row = store.getArtifact(scope, input.reportArtifactId);
  if (row === null) {
    throw new WorkbenchError(
      ERROR_CODES.NOT_FOUND,
      `report artifact ${input.reportArtifactId} not found`,
    );
  }
  const parsed = JSON.parse(
    new TextDecoder().decode(blobs.getVerified(row["blob_hash"] as string)),
  ) as unknown;
  const validate = validatorFor("CheckReport");
  if (!validate(parsed)) {
    throw new WorkbenchError(
      ERROR_CODES.SCHEMA_VALIDATION_FAILED,
      `artifact ${input.reportArtifactId} is not a valid CheckReport: ${formatErrors(validate.errors)}`,
    );
  }
  return parsed as CheckReport;
}

// ---------------------------------------------------------------------------
// Release checks (M4): the "release" ruleset runs against a compiled PDF
// artifact of a frozen snapshot. Every check is a real observation — the
// build row, the snapshot bytes, the render-helper output, or the reviews
// table. Unimplemented registry ids report "unsupported"; machine-undecidable
// outcomes report "needs-review". Nothing reports pass by default.
// ---------------------------------------------------------------------------

export interface ReleaseCheckDeps extends CheckDeps {
  repoRoot: string;
}

interface OutputProfile {
  id: string;
  requiredSections: string[];
  requiredCheckIds: string[];
}

interface VenueRequirement {
  id: string;
  /** The release-check id this requirement is verified by; null = manual. */
  checkImplementation?: string | null;
  mode?: string;
  severity?: string;
}

interface VenueProfile {
  id: string;
  status?: string;
  /** RFC3339 timestamp of the last real source fetch; null = never sourced. */
  checkedAt?: string | null;
  /** RFC3339 timestamp after which the sourced facts may be stale. */
  validUntil?: string | null;
  template?: { origin?: string } | null;
  requirements?: VenueRequirement[];
}

function loadProfileJson<T>(repoRoot: string, rel: string): T | null {
  const path = join(repoRoot, "resources", "profiles", rel);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

// ---- score-sum (exam mark totals) ------------------------------------------
// Deterministic extraction only: bracketed exam-class marks (\question[10],
// \part[5], \item[2]), parenthetical marks "(5 marks)"/"(3 分)", and declared
// totals (\total{40}, \setcounter{totalmarks}{40}, \newcommand{\totalmarks}{40},
// "Total: 40 marks", "满分40"). No inference: both sides must be observed to
// pass; a missing side is needs-review, never a fabricated total.

const MARK_BRACKET_RE =
  /\\(?:question|part|subpart|subsubpart|item)\s*\[\s*(\d+(?:\.\d+)?)\s*\]/g;
const MARK_PAREN_RE = /\((\d+(?:\.\d+)?)\s*(?:marks?|points?|pts?)\)/gi;
const MARK_ZH_RE = /[（(]\s*(\d+(?:\.\d+)?)\s*分\s*[）)]/g;
const TOTAL_RES: RegExp[] = [
  /\\(?:total|totalmarks|fullmarks|markstotal)\s*\{\s*(\d+(?:\.\d+)?)\s*\}/gi,
  /\\setcounter\s*\{\s*(?:totalmarks|markstotal|fullmarks)\s*\}\s*\{\s*(\d+(?:\.\d+)?)\s*\}/gi,
  /\\(?:newcommand|renewcommand|def)\s*\{?\\(?:total|totalmarks|fullmarks|markstotal)\}?\s*\{\s*(\d+(?:\.\d+)?)\s*\}/gi,
  /\btotal\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(?:marks?|points?)\b/gi,
  /满分\s*[:：]?\s*(\d+(?:\.\d+)?)/g,
];
const EXAM_STRUCTURE_RE =
  /\\begin\{questions\}|\\question\b|\\documentclass(?:\[[^\]]*\])?\s*\{exam\}/;

interface MarkScan {
  marks: number[];
  totals: number[];
  examStructure: boolean;
  /** file → extracted mark values (for the persisted record). */
  perFile: Record<string, { marks: number[]; totals: number[] }>;
}

function scanMarks(texSources: Map<string, string>): MarkScan {
  const scan: MarkScan = { marks: [], totals: [], examStructure: false, perFile: {} };
  const collect = (text: string, re: RegExp, into: number[]): void => {
    const r = new RegExp(re.source, re.flags);
    let m: RegExpExecArray | null;
    while ((m = r.exec(text)) !== null) {
      // TOTAL_NEWCMD_RE captures the macro name in group 1 — take last group.
      const raw = m[m.length - 1] as string;
      const v = Number.parseFloat(raw);
      if (Number.isFinite(v)) into.push(v);
    }
  };
  for (const [path, raw] of texSources) {
    const text = stripTexComments(raw);
    if (EXAM_STRUCTURE_RE.test(text)) scan.examStructure = true;
    const fileMarks: number[] = [];
    const fileTotals: number[] = [];
    collect(text, MARK_BRACKET_RE, fileMarks);
    collect(text, MARK_PAREN_RE, fileMarks);
    collect(text, MARK_ZH_RE, fileMarks);
    for (const re of TOTAL_RES) collect(text, re, fileTotals);
    if (fileMarks.length > 0 || fileTotals.length > 0) {
      scan.perFile[path] = { marks: fileMarks, totals: fileTotals };
    }
    scan.marks.push(...fileMarks);
    scan.totals.push(...fileTotals);
  }
  return scan;
}

// ---- answer-isolation (student exam release) --------------------------------
// Two layers, both deterministic: (1) the SOURCE — active \printanswers,
// solution/answer environments, \answer/\CorrectChoice commands and
// answer-key/marking-scheme text mark answer content that a source export
// leaks outright; (2) the shipped PDF — extracted text carrying
// answer/solution labels proves leakage in the artifact itself.

const ANSWER_SOURCE_RES: Array<{ id: string; re: RegExp; where: string }> = [
  { id: "printanswers", re: /\\printanswers\b/g, where: "active \\printanswers directive" },
  {
    id: "solution-env",
    re: /\\begin\s*\{\s*(?:solution|solutions|solutionbox|answer|answers|answerkey|markingscheme)\s*\}/gi,
    where: "solution/answer environment",
  },
  {
    id: "answer-cmd",
    re: /\\(?:answer|solution|correctchoice)\b/gi,
    where: "answer/correct-choice command",
  },
  {
    id: "scheme-text",
    re: /\b(?:answer\s*key|marking\s*scheme|model\s+answers?|marking\s+guide|marking\s+rubric)\b/gi,
    where: "answer-key/marking-scheme text",
  },
];
const ANSWER_PDF_RES: Array<{ id: string; re: RegExp; where: string }> = [
  { id: "answer-key", re: /\banswer\s*key\b/gi, where: "'answer key'" },
  { id: "scheme", re: /\bmarking\s*(?:scheme|guide|rubric)\b/gi, where: "marking-scheme text" },
  { id: "model-answer", re: /\bmodel\s+answers?\b/gi, where: "'model answer'" },
  { id: "solution-label", re: /\b(?:solution|answer)s?\s*[:：]/gi, where: "solution/answer label" },
];

interface AnswerFinding {
  where: string;
  match: string;
  location: string;
}

function buildResultOfJob(store: WorkbenchStore, scope: Scope, jobId: string): {
  state: string;
  action: string;
  snapshotId: string | null;
  buildResult: BuildResult | null;
} {
  const row = store.getJob(scope, jobId);
  if (row === null) return { state: "missing", action: "", snapshotId: null, buildResult: null };
  let buildResult: BuildResult | null = null;
  try {
    buildResult =
      (JSON.parse((row["result_json"] as string) ?? "{}") as { buildResult?: BuildResult })
        .buildResult ?? null;
  } catch {
    buildResult = null;
  }
  return {
    state: row["state"] as string,
    action: row["action"] as string,
    snapshotId: (row["snapshot_id"] as string | null) ?? null,
    buildResult,
  };
}

export interface ReleaseCheckInput {
  /** The compiled PDF artifact under check. */
  artifactId: string;
  rulesetId: string;
  releaseProfileId?: "draft" | "review" | "submission" | undefined;
  baselineArtifactId?: string | undefined;
}

export interface ReleaseCheckOutput {
  report: CheckReport;
  reportArtifactId: string;
  jobId: string;
  /** Page-image artifact ids this run published (empty when the renderer is
   * unavailable — visual-coverage then reports unsupported/needs-review). */
  pageArtifactIds: string[];
  /** Whether the release anonymization gate applies (venue requires it). */
  anonymizationRequired: boolean;
}

export async function runReleaseChecks(
  deps: ReleaseCheckDeps,
  input: ReleaseCheckInput,
): Promise<ReleaseCheckOutput> {
  const { store, blobs, ctx, scope } = deps;
  requireCapability(ctx, "data.render");
  const ruleset = CHECK_RULESETS[input.rulesetId];
  if (ruleset === undefined) {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `unknown rulesetId ${JSON.stringify(input.rulesetId)} — registered rulesets: ${Object.keys(CHECK_RULESETS).join(", ")}`,
    );
  }
  if (input.rulesetId !== "release") {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `runReleaseChecks only implements the "release" ruleset`,
    );
  }
  const subject = store.getArtifact(scope, input.artifactId);
  if (subject === null) {
    throw new WorkbenchError(ERROR_CODES.NOT_FOUND, `artifact ${input.artifactId} not found`);
  }
  if ((subject["kind"] as string) !== "pdf") {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `release checks run against the compiled pdf artifact; ${input.artifactId} is ${subject["kind"]}`,
    );
  }
  const snapshotId = subject["snapshot_id"] as string;
  const targetId = (subject["target_id"] as string | null) ?? null;

  // Review coverage participates in the dedup input: a re-run after new page
  // reviews must NOT replay the stale report.
  const coverageNow = pageReviewCoverage(store, scope, input.artifactId);
  const jobInput = {
    ...input,
    reviewDigest: digestJson({
      reviewed: coverageNow.pagesReviewed,
      flagged: coverageNow.pagesFlagged,
      total: coverageNow.pagesTotal,
    }),
  };

  const out = await runServiceJob<Omit<ReleaseCheckOutput, "jobId">>({
    store,
    blobs,
    ctx,
    scope,
    jobs: deps.jobs,
    action: "checks.release",
    snapshotId,
    targetId,
    input: jobInput,
    compute: async (jobId) => {
      const workDir = mkdtempSync(join(tmpdir(), `latexwb-checks-${jobId}-`));
      try {
        // ---- facts gathered once --------------------------------------
        const project = store.getProject(scope) as Row;
        const config = JSON.parse(project["config_json"] as string) as ProjectConfig;
        const targetRow = targetId !== null ? store.getTarget(scope, targetId) : null;
        const target = targetRow !== null
          ? (JSON.parse(targetRow["config_json"] as string) as Target)
          : null;
        const outputProfile = target !== null
          ? loadProfileJson<OutputProfile>(deps.repoRoot, join("outputs", `${target.outputProfileId}.json`))
          : null;
        const venueProfile = target?.venueProfileId != null
          ? loadProfileJson<VenueProfile>(deps.repoRoot, join("venues", `${target.venueProfileId}.json`))
          : null;
        const requiredCheckIds = outputProfile?.requiredCheckIds ?? [];
        const requiredSections = outputProfile?.requiredSections ?? [];
        const venueReqs = venueProfile?.requirements ?? [];
        const anonymizationRequired = venueReqs.some(
          (r) => r.checkImplementation === "anonymization-scan",
        );

        const snapshotFiles = store.listSnapshotFiles(scope, snapshotId);
        const texSources = new Map<string, string>();
        for (const f of snapshotFiles) {
          const p = f["path"] as string;
          if (/\.(tex|sty|cls|bib)$/i.test(p)) {
            texSources.set(
              p,
              new TextDecoder("utf8", { fatal: false }).decode(
                blobs.getVerified(f["blob_hash"] as string),
              ),
            );
          }
        }
        const build = buildResultOfJob(store, scope, subject["job_id"] as string);
        const diagnostics = build.buildResult?.diagnostics ?? [];

        // Render once (mode "pages" gives text + PNGs in one pass). Renderer
        // unavailable → renderInfo null; render-dependent checks report
        // unsupported, nothing is faked.
        let renderInfo: RenderedPdf | null = null;
        let renderError: string | null = null;
        const renderer = loadRenderer(deps.repoRoot);
        if (renderer !== null) {
          const pdfPath = join(workDir, "subject.pdf");
          writeFileSync(pdfPath, blobs.getVerified(subject["blob_hash"] as string));
          try {
            renderInfo = await renderPdf(deps.repoRoot, pdfPath, join(workDir, "out"), "pages", 72, {
              timeoutMs: (deps.hostPolicy?.limits?.buildTimeoutSeconds ?? 180) * 1000,
            });
          } catch (error) {
            renderError = error instanceof Error ? error.message : String(error);
            renderInfo = null;
          }
        } else {
          renderError = "render-helper not provisioned";
        }

        const artifacts: CollectedArtifact[] = [];
        const pageArtifactIds: string[] = [];
        let renderManifestArtifactId: string | null = null;

        if (renderInfo !== null && renderer !== null) {
          const manifestPages: unknown[] = [];
          for (const page of renderInfo.pages) {
            const pngName = `page-${page.page}.png`;
            let pngBytes: Buffer;
            try {
              pngBytes = readFileSync(join(workDir, "out", pngName));
            } catch {
              continue;
            }
            const blob = blobs.put(pngBytes);
            const artifactId = `page-image-${blob.hash.slice(0, 16)}`;
            artifacts.push({
              artifactId,
              relPath: pngName,
              kind: "page-image",
              blobHash: blob.hash,
              sizeBytes: pngBytes.length,
              mediaType: "image/png",
              manifestExtra: { page: page.page, pdfArtifactId: input.artifactId },
            });
            pageArtifactIds.push(artifactId);
            manifestPages.push({
              page: page.page,
              artifactId,
              sha256: blob.hash,
              sizePt: page.size,
              fonts: page.fonts,
              linkUrls: page.links.map((l) => l.url),
            });
          }
          const manifestRecord = {
            schemaVersion: 1,
            kind: "render-manifest",
            pdfArtifactId: input.artifactId,
            pdfSha256: subject["blob_hash"] as string,
            rendererManifestSha256: renderer.manifestSha256,
            helperVersion: renderer.manifest.version,
            dpi: 72,
            pageCount: renderInfo.pageCount,
            pages: manifestPages,
          };
          const manifestBytes = utf8Bytes(canonicalJson(manifestRecord));
          const manifestBlob = blobs.put(manifestBytes);
          renderManifestArtifactId = `manifest-${manifestBlob.hash.slice(0, 16)}`;
          artifacts.push({
            artifactId: renderManifestArtifactId,
            relPath: "render-manifest.json",
            kind: "manifest",
            blobHash: manifestBlob.hash,
            sizeBytes: manifestBytes.length,
            mediaType: "application/json",
            manifestExtra: { pdfArtifactId: input.artifactId, pageCount: renderInfo.pageCount },
          });
        }

        // ---- check evaluation ------------------------------------------
        // The check registry file is the source of truth for which ids are
        // sanctioned: an id the ruleset runs but the registry doesn't know is
        // drift (hard error); a registry entry marked non-live reports
        // unsupported with the registry's reason — even if code exists.
        const registry = loadProfileJson<{
          checks: Array<{ id: string; status?: string; unsupportedReason?: string }>;
        }>(deps.repoRoot, "check-registry.json");
        const registryById = new Map((registry?.checks ?? []).map((c) => [c.id, c]));
        const IMPLEMENTED = new Set([
          "build-current", "references-resolved", "required-sections",
          "assets-present", "protected-content", "text-extraction",
          "page-dimensions", "font-coverage", "anonymization-scan",
          "visual-coverage", "venue-profile", "baseline-compare",
          "answer-isolation", "asset-provenance", "score-sum",
        ]);
        for (const id of ruleset.checkIds) {
          const entry = registryById.get(id);
          if (entry === undefined) {
            throw new WorkbenchError(
              ERROR_CODES.INVALID_REQUEST,
              `check-registry drift: ruleset 'release' runs ${id} but resources/profiles/check-registry.json has no entry for it`,
            );
          }
          if (entry.status === "live" && !IMPLEMENTED.has(id)) {
            throw new WorkbenchError(
              ERROR_CODES.INVALID_REQUEST,
              `check-registry drift: ${id} is marked 'live' but has no implementation in runReleaseChecks`,
            );
          }
          if (entry.status !== "live" && IMPLEMENTED.has(id)) {
            throw new WorkbenchError(
              ERROR_CODES.INVALID_REQUEST,
              `check-registry drift: ${id} has an implementation but the registry does not mark it 'live'`,
            );
          }
        }

        const inputDigest = digestJson({
          artifactId: input.artifactId,
          rulesetId: input.rulesetId,
          snapshotId,
          targetId,
          baselineArtifactId: input.baselineArtifactId ?? null,
          releaseProfileId: input.releaseProfileId ?? null,
        });
        const now = utcNowIso();
        const results: CheckResult[] = [];
        const scopeDesc = { paths: [], pages: [], anchorIds: [input.artifactId] };
        const evidenceIds: string[] = [];

        const isRequired = (id: string): boolean => requiredCheckIds.includes(id);
        const push = (
          checkId: string,
          status: CheckResult["status"],
          findings: string[],
          extraEvidence: string[] = [],
          reviewerKind: CheckResult["reviewerKind"] = "deterministic",
        ): void => {
          const severity: CheckResult["severity"] =
            status === "pass" || status === "not-applicable"
              ? "info"
              : status === "fail"
                ? isRequired(checkId) ? "error" : "warning"
                : isRequired(checkId) ? "error" : "warning";
          results.push({
            checkId,
            checkVersion: "1",
            inputDigest,
            status,
            severity,
            scope: scopeDesc,
            findings,
            evidenceArtifactIds: extraEvidence,
            reviewerKind,
            checkedAt: now,
          });
        };

        // A check runs only when the ruleset lists it AND the registry marks
        // it 'live' — registry truth wins over code.
        const runCheck = (id: string): boolean =>
          ruleset.checkIds.includes(id) && registryById.get(id)?.status === "live";
        const renderUnsupported = (id: string): boolean => {
          if (renderInfo !== null) return false;
          push(id, "unsupported", [
            `render-helper unavailable: ${renderError ?? "not provisioned"} — this check needs the PDFKit render backend`,
          ]);
          return true;
        };

        // ---- build-current ------------------------------------------------
        if (runCheck("build-current")) {
          const ok =
            build.action === "build.run" &&
            build.state === "succeeded" &&
            build.buildResult?.status === "compiled" &&
            build.buildResult.pdfArtifactId === input.artifactId &&
            build.snapshotId === snapshotId;
          push(
            "build-current",
            ok ? "pass" : "fail",
            [
              ok
                ? `pdf ${input.artifactId} is the compiled output of build job ${subject["job_id"]} on this snapshot`
                : `no compiled build of snapshot ${snapshotId} produced pdf ${input.artifactId} (job ${subject["job_id"]} state=${build.state} status=${build.buildResult?.status ?? "none"})`,
            ],
          );
        }

        // ---- references-resolved -------------------------------------------
        if (runCheck("references-resolved")) {
          const bad = diagnostics.filter(
            (d) =>
              d.severity === "error" &&
              ["UNDEFINED_REFERENCE", "UNDEFINED_CITATION", "DUPLICATE_LABEL"].includes(d.code),
          );
          const qqPages = (renderInfo?.pages ?? [])
            .filter((p) => p.text.includes("??"))
            .map((p) => p.page);
          if (bad.length > 0 || qqPages.length > 0) {
            push("references-resolved", "fail", [
              ...bad.map((d) => `${d.code}: ${d.message}`),
              ...(qqPages.length > 0
                ? [`unresolved '??' markers in extracted text on page(s) ${qqPages.join(",")}`]
                : []),
            ]);
          } else if (renderInfo === null) {
            // Diagnostics are clean but we could not confirm no '??' markers
            // — that is a partial verification, not a pass.
            push("references-resolved", "needs-review", [
              `build diagnostics carry no unresolved-reference errors, but the PDF text could not be scanned (${renderError}) — '??' markers unverified`,
            ]);
          } else {
            push("references-resolved", "pass", [
              `no unresolved-reference diagnostics and no '??' markers across ${renderInfo.pageCount} page(s)`,
            ]);
          }
        }

        // ---- required-sections ----------------------------------------------
        if (runCheck("required-sections")) {
          if (requiredSections.length === 0) {
            push("required-sections", "not-applicable", [
              `output profile ${target?.outputProfileId ?? "?"} declares no required sections`,
            ]);
          } else {
            const declared = declaredSections(texSources);
            const missing = requiredSections.filter(
              (s) => ![...declared].some((d) => d === s || d.startsWith(s)),
            );
            push(
              "required-sections",
              missing.length === 0 ? "pass" : "fail",
              [
                missing.length === 0
                  ? `all ${requiredSections.length} required section(s) present`
                  : `required section(s) missing: ${missing.join(", ")}`,
              ],
            );
          }
        }

        // ---- assets-present ---------------------------------------------------
        if (runCheck("assets-present")) {
          const fileSet = new Set(snapshotFiles.map((f) => f["path"] as string));
          const missing: string[] = [];
          for (const ref of referencedAssets(texSources)) {
            const candidates = [
              ref.target,
              `${ref.target}.tex`, `${ref.target}.bib`,
              `${ref.target}.pdf`, `${ref.target}.png`, `${ref.target}.jpg`,
            ].flatMap((t) => [t, join(dirname(ref.from), t).replaceAll("\\", "/")]);
            if (!candidates.some((c) => fileSet.has(c))) {
              missing.push(`${ref.from}: ${ref.target}`);
            }
          }
          const missingAssetDiags = diagnostics.filter(
            (d) => d.severity === "error" && d.code === "MISSING_ASSET",
          );
          push(
            "assets-present",
            missing.length === 0 && missingAssetDiags.length === 0 ? "pass" : "fail",
            [
              ...(missing.length === 0
                ? [`all ${referencedAssets(texSources).length} referenced asset(s) resolve to snapshot files`]
                : [`unresolved asset references: ${missing.join("; ")}`]),
              ...missingAssetDiags.map((d) => `build diagnostic: ${d.message}`),
            ],
          );
        }

        // ---- protected-content ------------------------------------------------
        const protectedEvidenceArtifacts: string[] = [];
        if (runCheck("protected-content")) {
          const enabled = Object.entries(config.protectedContent)
            .filter(([, v]) => v === true)
            .map(([k]) => k);
          if (input.baselineArtifactId === undefined) {
            push("protected-content", "not-applicable", [
              "no baselineArtifactId supplied — nothing to compare against",
            ]);
          } else if (enabled.length === 0) {
            push("protected-content", "not-applicable", [
              "project config enables no protected-content categories",
            ]);
          } else {
            const baseline = store.getArtifact(scope, input.baselineArtifactId);
            if (baseline === null) {
              push("protected-content", "fail", [
                `baseline artifact ${input.baselineArtifactId} not found`,
              ]);
            } else {
              const baselineSnapshotId = baseline["snapshot_id"] as string;
              const changes: Array<{ path: string; category: string; detail: string }> = [];
              const baselineFiles = new Map(
                store
                  .listSnapshotFiles(scope, baselineSnapshotId)
                  .map((f) => [f["path"] as string, f]),
              );
              const categories = enabled as Array<keyof typeof config.protectedContent>;
              const textFiles = new Map<string, { before: string; after: string }>();
              for (const f of snapshotFiles) {
                const p = f["path"] as string;
                const bf = baselineFiles.get(p);
                if (!/\.(tex|sty|cls|bib)$/i.test(p)) continue;
                const after = texSources.get(p) ?? "";
                const before = bf === undefined
                  ? ""
                  : new TextDecoder("utf8", { fatal: false }).decode(
                      blobs.getVerified(bf["blob_hash"] as string),
                    );
                textFiles.set(p, { before, after });
              }
              // Files only in baseline = removed.
              for (const [p] of baselineFiles) {
                if (!textFiles.has(p) && /\.(tex|sty|cls|bib)$/i.test(p)) {
                  textFiles.set(p, {
                    before: new TextDecoder("utf8", { fatal: false }).decode(
                      blobs.getVerified(baselineFiles.get(p)!["blob_hash"] as string),
                    ),
                    after: "",
                  });
                }
              }
              const setKey: Record<string, keyof ReturnType<typeof extractProtectedSets>> = {
                math: "math",
                citationKeys: "citationKeys",
                labels: "labels",
                reportedResults: "reportedResults",
                quotes: "quotes",
              };
              for (const [path, { before, after }] of textFiles) {
                if (before === after) continue;
                const bSets = extractProtectedSets(before);
                const aSets = extractProtectedSets(after);
                for (const category of categories) {
                  const key = setKey[category as string];
                  if (key === undefined) continue;
                  const removed = bSets[key].filter((x) => !aSets[key].includes(x));
                  const added = aSets[key].filter((x) => !bSets[key].includes(x));
                  if (removed.length > 0 || added.length > 0) {
                    changes.push({
                      path,
                      category: category as string,
                      detail: `removed=${removed.slice(0, 5).join("|") || "none"} added=${added.slice(0, 5).join("|") || "none"}`,
                    });
                  }
                }
                // templateFiles / rawAssets are whole-file role comparisons.
                const role = (snapshotFiles.find((f) => f["path"] === path)?.["role"] as string) ?? "tex";
                if (categoryIncludes(categories, "templateFiles") && role === "template") {
                  changes.push({ path, category: "template", detail: "template file content changed" });
                }
                if (categoryIncludes(categories, "rawAssets") && role === "raw-asset") {
                  changes.push({ path, category: "raw-asset", detail: "raw asset bytes changed" });
                }
              }
              // Role-protected files that exist only in one snapshot.
              for (const [p, bf] of baselineFiles) {
                const role = bf["role"] as string;
                const inCurrent = snapshotFiles.some((f) => f["path"] === p);
                if (!inCurrent && ((role === "template" && categoryIncludes(categories, "templateFiles")) ||
                    (role === "raw-asset" && categoryIncludes(categories, "rawAssets")))) {
                  changes.push({ path: p, category: role, detail: "protected file removed" });
                }
              }

              let diffArtifactId: string | null = null;
              if (changes.length > 0) {
                const diff = canonicalJson({
                  kind: "protected-diff",
                  baselineArtifactId: input.baselineArtifactId,
                  baselineSnapshotId,
                  snapshotId,
                  categories: enabled,
                  changes,
                });
                const bytes = utf8Bytes(diff);
                const blob = blobs.put(bytes);
                diffArtifactId = `source-diff-${blob.hash.slice(0, 16)}`;
                artifacts.push({
                  artifactId: diffArtifactId,
                  relPath: "protected-diff.json",
                  kind: "source-diff",
                  blobHash: blob.hash,
                  sizeBytes: bytes.length,
                  mediaType: "application/json",
                  manifestExtra: { pdfArtifactId: input.artifactId },
                });
                protectedEvidenceArtifacts.push(diffArtifactId);
              }
              push(
                "protected-content",
                changes.length === 0 ? "pass" : "needs-review",
                [
                  changes.length === 0
                    ? `enabled categories ${enabled.join(",")} identical between baseline ${baselineSnapshotId.slice(0, 16)}… and ${snapshotId.slice(0, 16)}…`
                    : `${changes.length} protected-region difference(s) vs baseline — human sign-off required: ${changes.slice(0, 5).map((c) => `${c.path}(${c.category})`).join("; ")}${changes.length > 5 ? "…" : ""}`,
                ],
                protectedEvidenceArtifacts,
              );
            }
          }
        }

        // ---- text-extraction ---------------------------------------------------
        if (runCheck("text-extraction")) {
          if (!renderUnsupported("text-extraction")) {
            const empty = (renderInfo as RenderedPdf).pages
              .filter((p) => p.text.trim().length === 0)
              .map((p) => p.page);
            push(
              "text-extraction",
              empty.length === 0 ? "pass" : "needs-review",
              [
                empty.length === 0
                  ? `text extracted from all ${(renderInfo as RenderedPdf).pageCount} page(s)`
                  : `page(s) with no extractable text: ${empty.join(",")} — may be figure-only; a human should confirm`,
              ],
              renderManifestArtifactId !== null ? [renderManifestArtifactId] : [],
            );
          }
        }

        // ---- page-dimensions -----------------------------------------------------
        if (runCheck("page-dimensions")) {
          if (!renderUnsupported("page-dimensions")) {
            const sizes = new Map<string, number[]>();
            for (const p of (renderInfo as RenderedPdf).pages) {
              const k = `${p.size.w.toFixed(2)}x${p.size.h.toFixed(2)}`;
              sizes.set(k, [...(sizes.get(k) ?? []), p.page]);
            }
            push(
              "page-dimensions",
              sizes.size === 1 ? "pass" : "needs-review",
              [
                sizes.size === 1
                  ? `all pages ${[...sizes.keys()][0]}pt`
                  : `mixed page sizes: ${[...sizes.entries()].map(([s, ps]) => `${s}pt on p${ps.join(",")}`).join("; ")}`,
              ],
              renderManifestArtifactId !== null ? [renderManifestArtifactId] : [],
            );
          }
        }

        // ---- font-coverage ---------------------------------------------------------
        if (runCheck("font-coverage")) {
          if (!renderUnsupported("font-coverage")) {
            const unembedded = new Map<string, number[]>();
            let total = 0;
            for (const p of (renderInfo as RenderedPdf).pages) {
              for (const f of p.fonts) {
                total += 1;
                if (!f.embedded) {
                  unembedded.set(f.name, [...(unembedded.get(f.name) ?? []), p.page]);
                }
              }
            }
            if (total === 0) {
              push("font-coverage", "needs-review", [
                "no font resources discovered in the PDF — embedding cannot be verified",
              ]);
            } else if (unembedded.size === 0) {
              push("font-coverage", "pass", [
                `all ${total} font resource(s) embed font files (FontDescriptor FontFile*)`,
              ], renderManifestArtifactId !== null ? [renderManifestArtifactId] : []);
            } else {
              push("font-coverage", "needs-review", [
                `font(s) without embedded files: ${[...unembedded.entries()].map(([n, ps]) => `${n} (p${ps.join(",")})`).join("; ")} — venue tolerance is a human call`,
              ], renderManifestArtifactId !== null ? [renderManifestArtifactId] : []);
            }
          }
        }

        // ---- anonymization-scan ------------------------------------------------------
        const anonEvidence: string[] = [];
        let anonFindings: AnonFinding[] = [];
        if (runCheck("anonymization-scan")) {
          anonFindings = anonymizationScan(texSources, renderInfo?.pages ?? null);
          if (renderInfo === null) {
            // Source scan still ran; the pdf side is unverified — say so.
            anonFindings.push({ where: "scan-coverage", match: "pdf text unavailable", location: "pdf:*" });
          }
          const scanRecord = canonicalJson({
            kind: "anonymization-scan",
            artifactId: input.artifactId,
            anonymizationRequired,
            scannedSources: texSources.size,
            scannedPages: renderInfo?.pageCount ?? 0,
            findings: anonFindings,
          });
          const bytes = utf8Bytes(scanRecord);
          const blob = blobs.put(bytes);
          const artifactId = `report-${blob.hash.slice(0, 16)}`;
          artifacts.push({
            artifactId,
            relPath: "anonymization-scan.json",
            kind: "report",
            blobHash: blob.hash,
            sizeBytes: bytes.length,
            mediaType: "application/json",
            manifestExtra: { pdfArtifactId: input.artifactId },
          });
          anonEvidence.push(artifactId);
          evidenceIds.push(artifactId);
          const realFindings = anonFindings.filter((f) => f.where !== "scan-coverage");
          if (realFindings.length === 0 && renderInfo !== null) {
            push("anonymization-scan", "pass", [
              `no identifying content found in ${texSources.size} source file(s) and ${renderInfo.pageCount} page(s)`,
            ], anonEvidence);
          } else if (anonymizationRequired) {
            push("anonymization-scan", "fail", [
              `venue profile requires anonymized output; ${realFindings.length} identifying hit(s): ${realFindings.slice(0, 5).map((f) => `${f.where}@${f.location}`).join("; ")}`,
            ], anonEvidence);
          } else {
            push("anonymization-scan", "needs-review", [
              `${realFindings.length} identifying-content hit(s): ${realFindings.slice(0, 5).map((f) => `${f.where}@${f.location}`).join("; ")}${renderInfo === null ? "; pdf text unverified" : ""}`,
            ], anonEvidence);
          }
        }

        // ---- visual-coverage ---------------------------------------------------------
        if (runCheck("visual-coverage")) {
          const coverage = pageReviewCoverage(store, scope, input.artifactId);
          const total = coverage.pagesTotal;
          if (total === 0) {
            push(
              "visual-coverage",
              renderInfo === null ? "unsupported" : "needs-review",
              [
                renderInfo === null
                  ? `render-helper unavailable (${renderError}) — no page images exist to review`
                  : `pages rendered this run but no page-image artifacts are registered for pdf ${input.artifactId}`,
              ],
            );
          } else if (coverage.pagesFlagged.length > 0) {
            push("visual-coverage", "fail", [
              `reviewer(s) flagged page(s) ${coverage.pagesFlagged.join(",")} — a flagged page is a real defect, not a missing review`,
            ], coverage.manifestArtifactId !== null ? [coverage.manifestArtifactId] : []);
          } else if (coverage.pagesUnreviewed.length > 0) {
            push("visual-coverage", "needs-review", [
              `${coverage.pagesUnreviewed.length}/${total} page(s) unreviewed: ${coverage.pagesUnreviewed.join(",")}`,
            ], coverage.manifestArtifactId !== null ? [coverage.manifestArtifactId] : [], "human");
          } else {
            push("visual-coverage", "pass", [
              `all ${total} page(s) carry host reviews`,
            ], coverage.manifestArtifactId !== null ? [coverage.manifestArtifactId] : [], "human");
          }
        }

        // ---- venue-profile ---------------------------------------------------------------
        if (runCheck("venue-profile")) {
          if (target?.venueProfileId == null) {
            push("venue-profile", "not-applicable", ["target declares no venue profile"]);
          } else if (venueProfile === null) {
            push("venue-profile", "fail", [
              `target declares venue profile ${target.venueProfileId} but no resource file resources/profiles/venues/${target.venueProfileId}.json exists`,
            ]);
          } else {
            // Each requirement's checkImplementation names the check that
            // verifies it in THIS run; null means the contract itself marks
            // the requirement as manual — the venue check reports
            // needs-review for those rather than pretending to verify them.
            const unsatisfied: string[] = [];
            const manual: string[] = [];
            for (const req of venueReqs) {
              const checkId = req.checkImplementation ?? null;
              if (checkId === null) {
                manual.push(`${req.id}: manual requirement (mode=${req.mode ?? "unknown"})`);
                continue;
              }
              const result = results.find((r) => r.checkId === checkId);
              if (result === undefined) {
                unsatisfied.push(`${req.id}: required check ${checkId} was not run`);
              } else if (result.status !== "pass" && result.status !== "not-applicable") {
                unsatisfied.push(`${req.id}: check ${checkId} is ${result.status}`);
              }
            }
            // RELEASE-04 staleness: a non-internal profile that was never
            // sourced (checkedAt missing), declared expired, or past its
            // validUntil must not silently pass — venue rules change and the
            // requirements below may no longer be the current ones.
            const staleReasons: string[] = [];
            if (venueProfile.template?.origin !== "internal") {
              if (venueProfile.checkedAt === null || venueProfile.checkedAt === undefined) {
                staleReasons.push("checkedAt is missing — profile was never sourced");
              }
              if (venueProfile.status === "expired") {
                staleReasons.push("profile status is 'expired'");
              }
              const vu = venueProfile.validUntil;
              if (vu !== null && vu !== undefined && vu <= utcNowIso()) {
                staleReasons.push(`validUntil ${vu} is in the past (now ${utcNowIso()})`);
              }
            }
            const notes = [
              `venue profile ${venueProfile.id} status=${venueProfile.status ?? "unknown"} (${venueReqs.length} requirement(s))`,
              ...staleReasons.map((r) => `staleness: ${r}`),
            ];
            // Stale profile + any error-severity requirement → fail (the
            // unverified requirement may be load-bearing); otherwise stale
            // alone degrades pass to needs-review, never silently passing.
            const staleFail = staleReasons.length > 0 && venueReqs.some((r) => r.severity === "error");
            push(
              "venue-profile",
              unsatisfied.length > 0 || staleFail
                ? "fail"
                : manual.length > 0 || staleReasons.length > 0
                  ? "needs-review"
                  : "pass",
              [...notes, ...unsatisfied, ...manual],
            );
          }
        }

        // ---- baseline-compare ------------------------------------------------------------
        if (runCheck("baseline-compare")) {
          if (input.baselineArtifactId === undefined) {
            push("baseline-compare", "not-applicable", [
              "no baselineArtifactId supplied — first release or no baseline captured",
            ]);
          } else {
            const baseline = store.getArtifact(scope, input.baselineArtifactId);
            if (baseline === null) {
              push("baseline-compare", "fail", [
                `baseline artifact ${input.baselineArtifactId} not found`,
              ]);
            } else if ((baseline["kind"] as string) !== "pdf") {
              push("baseline-compare", "not-applicable", [
                `baseline ${input.baselineArtifactId} is ${baseline["kind"]}, not a pdf — baseline comparison is defined over PDFs`,
              ]);
            } else if ((baseline["blob_hash"] as string) === (subject["blob_hash"] as string)) {
              push("baseline-compare", "pass", [
                `current pdf is byte-identical to baseline ${input.baselineArtifactId}`,
              ]);
            } else if (renderInfo === null) {
              push("baseline-compare", "unsupported", [
                `pdfs differ but render-helper is unavailable (${renderError}) — page-level comparison impossible`,
              ]);
            } else {
              // Render the baseline too and compare per-page text + count.
              let baselineInfo: RenderedPdf | null = null;
              try {
                const bp = join(workDir, "baseline.pdf");
                writeFileSync(bp, blobs.getVerified(baseline["blob_hash"] as string));
                baselineInfo = await renderPdf(deps.repoRoot, bp, join(workDir, "base-out"), "json", 72);
              } catch (error) {
                baselineInfo = null;
                push("baseline-compare", "unsupported", [
                  `baseline pdf ${input.baselineArtifactId} failed to render: ${(error as Error).message}`,
                ]);
              }
              if (baselineInfo !== null) {
                const pages: Array<{ page: number; textEqual: boolean }> = [];
                const n = Math.max(baselineInfo.pageCount, renderInfo.pageCount);
                for (let i = 1; i <= n; i += 1) {
                  const b = baselineInfo.pages.find((p) => p.page === i);
                  const c = renderInfo.pages.find((p) => p.page === i);
                  pages.push({ page: i, textEqual: b !== undefined && c !== undefined && b.text === c.text });
                }
                const changed = pages.filter((p) => !p.textEqual).map((p) => p.page);
                const diff = canonicalJson({
                  kind: "baseline-diff",
                  baselineArtifactId: input.baselineArtifactId,
                  artifactId: input.artifactId,
                  baselinePages: baselineInfo.pageCount,
                  currentPages: renderInfo.pageCount,
                  pagesChanged: changed,
                });
                const bytes = utf8Bytes(diff);
                const blob = blobs.put(bytes);
                const diffArtifactId = `source-diff-${blob.hash.slice(0, 16)}`;
                artifacts.push({
                  artifactId: diffArtifactId,
                  relPath: "baseline-diff.json",
                  kind: "source-diff",
                  blobHash: blob.hash,
                  sizeBytes: bytes.length,
                  mediaType: "application/json",
                  manifestExtra: { pdfArtifactId: input.artifactId },
                });
                push(
                  "baseline-compare",
                  "needs-review",
                  [
                    `pdfs differ: ${baselineInfo.pageCount}→${renderInfo.pageCount} page(s); text changed on page(s) ${changed.join(",") || "none"} — human review of the diff is required`,
                  ],
                  [diffArtifactId],
                );
              }
            }
          }
        }

        // ---- score-sum (exam mark-total verification) ------------------------
        // RELEASE-02: sums every observed mark annotation against every
        // declared total found in the de-commented source. Both sides must be
        // observed to pass; missing sides degrade to needs-review — never a
        // fabricated total, never an inferred mark.
        if (runCheck("score-sum")) {
          const scan = scanMarks(texSources);
          const sum = scan.marks.reduce((a, b) => a + b, 0);
          const scoreBytes = utf8Bytes(
            canonicalJson({
              kind: "score-sum",
              artifactId: input.artifactId,
              snapshotId,
              perFile: scan.perFile,
              markCount: scan.marks.length,
              sum,
              declaredTotals: scan.totals,
            }),
          );
          const scoreBlob = blobs.put(scoreBytes);
          const scoreArtifactId = `report-${scoreBlob.hash.slice(0, 16)}`;
          artifacts.push({
            artifactId: scoreArtifactId,
            relPath: "score-sum.json",
            kind: "report",
            blobHash: scoreBlob.hash,
            sizeBytes: scoreBytes.length,
            mediaType: "application/json",
            manifestExtra: { pdfArtifactId: input.artifactId },
          });
          if (scan.marks.length === 0 && scan.totals.length === 0) {
            if (scan.examStructure) {
              push("score-sum", "needs-review", [
                "exam structure (question environment/class) present but no mark values or declared totals were found — mark coverage cannot be verified",
              ], [scoreArtifactId]);
            } else {
              push("score-sum", "not-applicable", [
                "no mark annotations or declared totals in the source — not an exam-marked document",
              ], [scoreArtifactId]);
            }
          } else if (scan.marks.length === 0) {
            push("score-sum", "needs-review", [
              `declared total(s) ${scan.totals.join(", ")} but no individual mark annotations to sum`,
            ], [scoreArtifactId]);
          } else if (scan.totals.length === 0) {
            push("score-sum", "needs-review", [
              `${scan.marks.length} mark annotation(s) sum to ${sum} but no declared total was found — nothing to verify the sum against`,
            ], [scoreArtifactId]);
          } else {
            const match = scan.totals.some((t) => Math.abs(t - sum) < 1e-9);
            push(
              "score-sum",
              match ? "pass" : "fail",
              [
                match
                  ? `${scan.marks.length} mark annotation(s) sum to ${sum} — matches declared total`
                  : `${scan.marks.length} mark annotation(s) sum to ${sum} but declared total(s) are ${[...new Set(scan.totals)].join(", ")}`,
              ],
              [scoreArtifactId],
            );
          }
        }

        // ---- answer-isolation (student exam release) ---------------------------
        // RELEASE-02: detects answer leakage in what the student release ships.
        // Active \printanswers or answer-labelled PDF text = fail; answer
        // content confined to source (a source export would leak it) =
        // needs-review; clean source + verified-clean PDF = pass.
        if (runCheck("answer-isolation")) {
          const sourceFindings: AnswerFinding[] = [];
          const pdfFindings: AnswerFinding[] = [];
          for (const [path, raw] of texSources) {
            const text = stripTexComments(raw);
            for (const { re, where } of ANSWER_SOURCE_RES) {
              const r = new RegExp(re.source, re.flags);
              let m: RegExpExecArray | null;
              while ((m = r.exec(text)) !== null) {
                sourceFindings.push({ where, match: m[0].slice(0, 80), location: `source:${path}` });
              }
            }
          }
          if (renderInfo !== null) {
            for (const p of renderInfo.pages) {
              for (const { re, where } of ANSWER_PDF_RES) {
                const r = new RegExp(re.source, re.flags);
                let m: RegExpExecArray | null;
                while ((m = r.exec(p.text)) !== null) {
                  pdfFindings.push({ where, match: m[0].slice(0, 80), location: `pdf:page-${p.page}` });
                }
              }
            }
          }
          const scanBytes = utf8Bytes(
            canonicalJson({
              kind: "answer-isolation-scan",
              artifactId: input.artifactId,
              snapshotId,
              sourceFindings,
              pdfFindings,
              pdfScanned: renderInfo !== null,
            }),
          );
          const scanBlob = blobs.put(scanBytes);
          const scanArtifactId = `report-${scanBlob.hash.slice(0, 16)}`;
          artifacts.push({
            artifactId: scanArtifactId,
            relPath: "answer-isolation-scan.json",
            kind: "report",
            blobHash: scanBlob.hash,
            sizeBytes: scanBytes.length,
            mediaType: "application/json",
            manifestExtra: { pdfArtifactId: input.artifactId },
          });
          const activePrintanswers = sourceFindings.filter((f) => f.where.includes("printanswers"));
          if (activePrintanswers.length > 0 || pdfFindings.length > 0) {
            push("answer-isolation", "fail", [
              ...activePrintanswers.map((f) => `${f.where} at ${f.location}`),
              ...pdfFindings.slice(0, 10).map((f) => `${f.where} '${f.match}' at ${f.location}`),
              ...(pdfFindings.length > 10 ? [`…${pdfFindings.length - 10} more pdf finding(s)`] : []),
            ], [scanArtifactId]);
          } else if (sourceFindings.length > 0) {
            push("answer-isolation", "needs-review", [
              `answer content present in source (${sourceFindings.slice(0, 5).map((f) => `${f.where}@${f.location}`).join("; ")}) — typeset PDF carries no answer labels, but a source export would leak ${sourceFindings.length} marker(s)`,
              ...(renderInfo === null ? ["pdf text unavailable — PDF cleanliness unverified"] : []),
            ], [scanArtifactId]);
          } else if (renderInfo === null) {
            push("answer-isolation", "needs-review", [
              `source scan found no answer markers, but pdf text is unavailable (${renderError}) — PDF cleanliness unverified`,
            ], [scanArtifactId]);
          } else {
            push("answer-isolation", "pass", [
              `no answer/solution/marking markers in ${texSources.size} source file(s) or ${renderInfo.pageCount} pdf page(s)`,
            ], [scanArtifactId]);
          }
        }

        // ---- asset-provenance ---------------------------------------------------
        // Verifies WHERE every asset's bytes came from — not licensing (no
        // attestation model exists). Raw assets must round-trip through CAS
        // under their recorded blob hash; generated assets must carry a
        // complete generation record (source asset + recipe + parameters +
        // produced artifacts) whose references all resolve in this snapshot.
        if (runCheck("asset-provenance")) {
          const assetFiles = snapshotFiles.filter(
            (f) => f["role"] === "raw-asset" || f["role"] === "generated-asset",
          );
          const genEvidence = listEvidence(store, scope, {
            snapshotId,
            kind: "generated-asset",
          });
          const provenance: Array<{
            path?: string;
            evidenceId?: string;
            kind: string;
            verified: boolean;
            detail: string;
          }> = [];
          const failures: string[] = [];
          for (const f of assetFiles) {
            const path = f["path"] as string;
            const hash = f["blob_hash"] as string;
            try {
              const bytes = blobs.getVerified(hash);
              const ok = bytes.length === (f["size_bytes"] as number);
              provenance.push({
                path,
                kind: f["role"] as string,
                verified: ok,
                detail: ok
                  ? `CAS-verified sha256=${hash.slice(0, 12)}… (${bytes.length}B)`
                  : `size mismatch: row=${f["size_bytes"]} blob=${bytes.length}`,
              });
              if (!ok) failures.push(`${path}: size mismatch vs snapshot row`);
            } catch (error) {
              provenance.push({
                path,
                kind: f["role"] as string,
                verified: false,
                detail: `CAS read failed: ${(error as Error).message}`,
              });
              failures.push(`${path}: blob ${hash.slice(0, 12)}… fails CAS verification`);
            }
          }
          for (const ev of genEvidence) {
            const rec = ev.record as {
              sourceAssetId?: string;
              recipeHash?: string;
              parametersHash?: string;
              texArtifactId?: string | null;
              pdfArtifactId?: string | null;
              mappingArtifactId?: string | null;
            };
            const problems: string[] = [];
            if (typeof rec.sourceAssetId !== "string" || rec.sourceAssetId.length === 0) {
              problems.push("no sourceAssetId");
            } else if (
              !snapshotFiles.some(
                (f) =>
                  (f["blob_hash"] as string).slice(0, 12) ===
                  (rec.sourceAssetId as string).replace(/^asset-/, ""),
              )
            ) {
              problems.push(`sourceAssetId ${rec.sourceAssetId} matches no file in snapshot`);
            }
            for (const field of ["recipeHash", "parametersHash"] as const) {
              if (typeof rec[field] !== "string" || rec[field].length === 0) {
                problems.push(`missing ${field}`);
              }
            }
            for (const field of ["texArtifactId", "mappingArtifactId"] as const) {
              const id = rec[field];
              if (typeof id !== "string" || id.length === 0) {
                problems.push(`missing ${field}`);
              } else if (store.getArtifact(scope, id) === null) {
                problems.push(`${field} ${id} does not resolve`);
              }
            }
            provenance.push({
              evidenceId: ev.evidenceId,
              kind: "generated-asset",
              verified: problems.length === 0,
              detail:
                problems.length === 0
                  ? `source asset + recipe + parameters + artifacts verified (${ev.sourceLocator})`
                  : problems.join("; "),
            });
            if (problems.length > 0) {
              failures.push(`generated-asset evidence ${ev.evidenceId}: ${problems.join("; ")}`);
            }
          }
          const provBytes = utf8Bytes(
            canonicalJson({
              kind: "asset-provenance",
              artifactId: input.artifactId,
              snapshotId,
              assets: provenance,
            }),
          );
          const provBlob = blobs.put(provBytes);
          const provArtifactId = `report-${provBlob.hash.slice(0, 16)}`;
          artifacts.push({
            artifactId: provArtifactId,
            relPath: "asset-provenance.json",
            kind: "report",
            blobHash: provBlob.hash,
            sizeBytes: provBytes.length,
            mediaType: "application/json",
            manifestExtra: { pdfArtifactId: input.artifactId },
          });
          if (provenance.length === 0) {
            push("asset-provenance", "not-applicable", [
              "snapshot contains no raw/generated assets — nothing to verify provenance for",
            ], [provArtifactId]);
          } else if (failures.length > 0) {
            push("asset-provenance", "fail", [
              `${failures.length} provenance failure(s): ${failures.slice(0, 8).join("; ")}${failures.length > 8 ? "…" : ""}`,
            ], [provArtifactId]);
          } else {
            push("asset-provenance", "pass", [
              `${assetFiles.length} raw asset(s) CAS-verified, ${genEvidence.length} generated-asset record(s) fully resolved`,
            ], [provArtifactId]);
          }
        }

        // ---- registry-declared non-live ids: honest unsupported ----------
        for (const id of ruleset.checkIds) {
          if (registryById.get(id)?.status !== "live") {
            const reason = registryById.get(id)?.unsupportedReason
              ?? `check ${id} is declared in the check registry but has no implementation`;
            push(id, "unsupported", [
              `${reason} — a required check that cannot run blocks release honestly`,
            ]);
          }
        }

        const blockingIds = results
          .filter(
            (r) =>
              (r.status === "fail" && r.severity === "error") ||
              (r.status === "unsupported" && isRequired(r.checkId)),
          )
          .map((r) => r.checkId);
        const missingReviewIds = results
          .filter(
            (r) =>
              r.status === "needs-review" ||
              (r.status === "unsupported" && !isRequired(r.checkId)),
          )
          .map((r) => r.checkId);

        const coverage = pageReviewCoverage(store, scope, input.artifactId);
        const protectedTotals = [...texSources.values()].reduce(
          (acc, t) => {
            const s = extractProtectedSets(t);
            return acc + s.math.length + s.citationKeys.length + s.labels.length +
              s.reportedResults.length + s.quotes.length;
          },
          0,
        );

        const report: CheckReport = {
          kind: "check-report",
          reportId: `cr-${randomUUID()}`,
          artifactId: input.artifactId,
          snapshotId,
          requiredCheckIds,
          results,
          coverage: {
            pagesTotal: coverage.pagesTotal,
            pagesReviewed: coverage.pagesReviewed,
            trackedValues: protectedTotals,
            candidateValues: protectedTotals,
          },
          blockingIds,
          missingReviewIds,
          inputDigest,
        };
        const reportBytes = utf8Bytes(canonicalJson(report));
        const reportBlob = blobs.put(reportBytes);
        const reportArtifactId = `report-${reportBlob.hash.slice(0, 16)}`;
        artifacts.push({
          artifactId: reportArtifactId,
          relPath: `check-report-${report.reportId}.json`,
          kind: "report",
          blobHash: reportBlob.hash,
          sizeBytes: reportBytes.length,
          mediaType: "application/json",
          manifestExtra: { pdfArtifactId: input.artifactId },
        });
        const now2 = utcNowIso();
        return {
          result: {
            report,
            reportArtifactId,
            pageArtifactIds,
            anonymizationRequired,
          } satisfies Omit<ReleaseCheckOutput, "jobId">,
          publishExtra: () => {
            results.forEach((r, i) => {
              store.insertCheck(scope, {
                checkRunId: `${report.reportId}-${i}`,
                artifactId: input.artifactId,
                snapshotId,
                checkId: r.checkId,
                checkVersion: r.checkVersion,
                inputDigest: r.inputDigest,
                status: r.status,
                resultJson: canonicalJson(r),
                createdAt: now2,
              });
            });
          },
          artifacts,
          evidence: [
            {
              snapshotId,
              kind: "check-report",
              sourceLocator: `artifact:${input.artifactId}`,
              content: reportBytes,
              accessStatus: "metadata-only",
              record: {
                reportId: report.reportId,
                rulesetId: input.rulesetId,
                requiredCheckIds,
                blockingIds,
                missingReviewIds,
              },
            },
            ...(renderInfo !== null && renderer !== null
              ? [{
                  snapshotId,
                  kind: "render-manifest",
                  sourceLocator: `artifact:${input.artifactId}`,
                  content: utf8Bytes(canonicalJson({
                    pdfArtifactId: input.artifactId,
                    rendererManifestSha256: renderer.manifestSha256,
                    pageCount: renderInfo.pageCount,
                  })),
                  accessStatus: "fulltext" as const,
                  record: {
                    pdfArtifactId: input.artifactId,
                    rendererManifestSha256: renderer.manifestSha256,
                    pageCount: renderInfo.pageCount,
                  },
                }]
              : []),
            ...(anonFindings.length > 0
              ? [{
                  snapshotId,
                  kind: "anonymization-scan",
                  sourceLocator: `artifact:${input.artifactId}`,
                  content: utf8Bytes(canonicalJson(anonFindings)),
                  accessStatus: "fulltext" as const,
                  record: { findingCount: anonFindings.length, anonymizationRequired },
                }]
              : []),
          ],
        };
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    },
  });
  return { ...out.result, jobId: out.jobId };
}

function categoryIncludes(categories: readonly string[], name: string): boolean {
  return categories.includes(name);
}

// ---------------------------------------------------------------------------
// Draft lint (ruleset "draft"): fast, deterministic SOURCE checks for
// ordinary writing, in the spirit of chktex/lacheck/textidote. It runs
// against the compiled PDF artifact of any build: sources come from that
// artifact's frozen snapshot, build-log facts from the build job that
// produced it. Every source scan works on a comment-masked view that
// preserves string length (offsets and line numbers stay exact), so
// commented-out text never produces a finding. Findings read
// "path:line …", are sorted by (path, offset) and capped. The pure source
// lint (lintDraftSources) lives in @latexwb/latex-kit; this module adds the
// registry check, the build-log summary and the persisted report.
// ---------------------------------------------------------------------------

export interface DraftCheckInput {
  /** The compiled PDF artifact whose snapshot + build log are linted. */
  artifactId: string;
  rulesetId: string;
  /** Not used by the draft ruleset — supplying one is a caller error. */
  baselineArtifactId?: string | undefined;
}

export interface DraftCheckOutput {
  report: CheckReport;
  reportArtifactId: string;
  jobId: string;
}

/** Fail on registry drift: every draft id must be registered 'live', and a
 * live `draft.*` registry entry must be implemented here. */
function assertDraftRegistry(repoRoot: string, checkIds: readonly string[]): void {
  const registry = loadProfileJson<{
    checks: Array<{ id: string; status?: string }>;
  }>(repoRoot, "check-registry.json");
  const byId = new Map((registry?.checks ?? []).map((c) => [c.id, c]));
  for (const id of checkIds) {
    const entry = byId.get(id);
    if (entry === undefined) {
      throw new WorkbenchError(
        ERROR_CODES.INVALID_REQUEST,
        `check-registry drift: ruleset 'draft' runs ${id} but resources/profiles/check-registry.json has no entry for it`,
      );
    }
    if (entry.status !== "live") {
      throw new WorkbenchError(
        ERROR_CODES.INVALID_REQUEST,
        `check-registry drift: ${id} has an implementation but the registry does not mark it 'live'`,
      );
    }
  }
  for (const entry of registry?.checks ?? []) {
    if (entry.id.startsWith("draft.") && entry.status === "live" && !checkIds.includes(entry.id)) {
      throw new WorkbenchError(
        ERROR_CODES.INVALID_REQUEST,
        `check-registry drift: ${entry.id} is marked 'live' but has no implementation in runDraftChecks`,
      );
    }
  }
}

/**
 * Where the TeX log reads snapshot sources: one pass over the log's
 * parentheses yields, for every `(file` open that resolves to a snapshot
 * .tex file (with or without extension — Tectonic logs `(sections/method`
 * for \input{sections/method}), the 0-based log lines it spans. Package
 * chatter never resolves to a snapshot file, so it cannot be mistaken for
 * a source; it only takes part in paren matching.
 */
function logSourceSpans(
  logLines: readonly string[],
  texLineCounts: ReadonlyMap<string, number>,
): Array<{ path: string; open: number; close: number }> {
  const memo = new Map<string, string | null>();
  const resolveToken = (raw: string): string | null => {
    const cached = memo.get(raw);
    if (cached !== undefined) return cached;
    const token = raw.replace(/^\.\//, "");
    let best: string | null = null;
    if (texLineCounts.has(token)) best = token;
    else if (texLineCounts.has(`${token}.tex`)) best = `${token}.tex`;
    else {
      for (const p of texLineCounts.keys()) {
        const hit = token.endsWith(`/${p}`) || `${token}.tex`.endsWith(`/${p}`);
        if (hit && (best === null || p.length > best.length)) best = p;
      }
    }
    memo.set(raw, best);
    return best;
  };
  const spans: Array<{ path: string; open: number; close: number }> = [];
  const stack: Array<number | null> = []; // index into spans, or null for other parens
  for (let i = 0; i < logLines.length; i += 1) {
    const line = logLines[i] as string;
    for (let c = 0; c < line.length; c += 1) {
      const ch = line[c];
      if (ch === "(") {
        const token = /^[^\s()]+/.exec(line.slice(c + 1, c + 512));
        const path = token === null ? null : resolveToken(token[0]);
        if (path === null) {
          stack.push(null);
        } else {
          spans.push({ path, open: i, close: Number.POSITIVE_INFINITY });
          stack.push(spans.length - 1);
        }
      } else if (ch === ")") {
        const top = stack.pop();
        if (top !== undefined && top !== null) (spans[top] as { close: number }).close = i;
      }
    }
  }
  return spans;
}

/** The innermost snapshot source open at 1-based log line `atLine`. */
function logFileAt(
  spans: ReadonlyArray<{ path: string; open: number; close: number }>,
  atLine: number,
): string | null {
  const idx = atLine - 1;
  for (let k = spans.length - 1; k >= 0; k -= 1) {
    const s = spans[k] as { path: string; open: number; close: number };
    if (s.open < idx && s.close >= idx) return s.path;
  }
  return null;
}

/** draft.build-log: summarize the build job that produced the pdf. */
function draftBuildLog(
  build: ReturnType<typeof buildResultOfJob>,
  logText: string | null,
  snapshotPaths: ReadonlySet<string>,
  texLineCounts: ReadonlyMap<string, number>,
): Omit<DraftLintResult, "checkId"> {
  const br = build.buildResult;
  if (br === null) {
    return {
      status: "unsupported",
      severity: "info",
      findings: [
        `the producing job (action ${build.action || "unknown"}, state ${build.state}) stored no build result — there is no build log to summarize`,
      ],
      paths: [],
    };
  }
  const mapPath = (p: string | null | undefined): string | null => {
    if (p === null || p === undefined || p === "") return null;
    if (snapshotPaths.has(p)) return p;
    const hits = [...snapshotPaths].filter((s) => p.endsWith(`/${s}`)).sort((a, b) => b.length - a.length);
    return hits[0] ?? null;
  };
  const overfull: Array<{ path: string | null; line: number | null; text: string }> = [];
  const paths = new Set<string>();
  let spans: ReturnType<typeof logSourceSpans> | null = null;
  for (const d of br.diagnostics) {
    if (d.code !== "OVERFULL_BOX") continue;
    const am = /Overfull \\([hv])box \(([\d.]+)pt too (?:wide|high)\)/.exec(d.message);
    const amount = am === null ? Number.NaN : Number.parseFloat(am[2] as string);
    if (!(amount > 1)) continue;
    // The diagnostic parser's file stack misses extensionless opens, so the
    // raw log decides the file when it can; the diagnostic path is a
    // fallback. A line beyond the file's end means the file is wrong.
    if (spans === null && logText !== null) spans = logSourceSpans(logText.split("\n"), texLineCounts);
    const fromLog = spans !== null && d.rawLogRange !== null
      ? logFileAt(spans, d.rawLogRange.startLine)
      : null;
    const path = fromLog ?? mapPath(d.source?.path);
    const lm = /at lines? (\d+)/.exec(d.message);
    const rawLine = d.source?.line ?? (lm === null ? null : Number.parseInt(lm[1] as string, 10));
    const line = rawLine !== null && path !== null && rawLine <= (texLineCounts.get(path) ?? Infinity)
      ? rawLine
      : null;
    if (path !== null) paths.add(path);
    const where = path === null ? "" : line === null ? `${path} ` : `${path}:${line} `;
    const logLine = path === null && d.rawLogRange !== null ? ` (log line ${d.rawLogRange.startLine})` : "";
    overfull.push({
      path,
      line,
      text: `${where}overfull \\${am?.[1] ?? "h"}box ${amount.toFixed(1)}pt too wide${logLine}`,
    });
  }
  overfull.sort((a, b) =>
    cmpStr(a.path ?? "￿", b.path ?? "￿") || (a.line ?? 0) - (b.line ?? 0) || cmpStr(a.text, b.text));
  const keyOf = (msg: string): string => /`([^']+)'/.exec(msg)?.[1] ?? msg;
  const byCode = (code: string): Diagnostic[] => br.diagnostics.filter((d) => d.code === code);
  const other: string[] = [];
  for (const d of byCode("UNDEFINED_REFERENCE")) {
    other.push(`undefined reference "${keyOf(d.message)}"${d.page !== null ? ` (page ${d.page})` : ""}`);
  }
  for (const d of byCode("UNDEFINED_CITATION")) {
    other.push(`undefined citation "${keyOf(d.message)}"${d.page !== null ? ` (page ${d.page})` : ""}`);
  }
  for (const d of byCode("DUPLICATE_LABEL")) {
    other.push(`label "${keyOf(d.message)}" multiply defined`);
  }
  for (const d of byCode("MISSING_GLYPH")) {
    other.push(`missing glyph: ${d.message.replace(/^Missing character:\s*/, "")}`);
  }
  if (logText !== null) {
    const subs: string[] = [];
    for (const m of logText.matchAll(
      /LaTeX Font Warning: Font shape `([^']+)' (?:undefined|in size <([^>]+)> not available)\s*\n\(Font\)\s+(?:using `([^']+)' instead|size <([^>]+)> substituted)/g,
    )) {
      subs.push(
        m[3] !== undefined
          ? `font substitution: ${m[1] as string} undefined → using ${m[3]}`
          : `font substitution: ${m[1] as string} at size ${m[2] ?? "?"} not available → size ${m[4] ?? "?"}`,
      );
    }
    if (
      subs.length === 0 &&
      /LaTeX Font Warning: Some font shapes were not available, defaults substituted/.test(logText)
    ) {
      subs.push("font substitution: some font shapes were not available, defaults substituted");
    }
    other.push(...subs);
  }
  const findings = [...new Set([...overfull.map((o) => o.text), ...other])];
  if (findings.length === 0) {
    const fontNote = logText !== null
      ? " or font substitutions"
      : " (font-substitution scan skipped: log artifact unavailable)";
    return {
      status: "pass",
      severity: "info",
      findings: [
        `build job ${br.jobId}: no overfull boxes > 1pt, undefined references/citations, missing glyphs${fontNote}`,
      ],
      paths: [],
    };
  }
  return {
    status: "fail",
    severity: "warning",
    findings: capFindings(findings),
    paths: [...paths].sort(cmpStr),
  };
}

/**
 * `latex_check run` with rulesetId "draft": source lint of the snapshot a
 * compiled PDF was built from, plus a summary of that build's log. Gates
 * nothing (requiredCheckIds is empty); blockingIds still lists fail+error
 * results (duplicate labels, missing citation keys) because those produce
 * wrong output — the same rule the other rulesets apply.
 */
export async function runDraftChecks(
  deps: ReleaseCheckDeps,
  input: DraftCheckInput,
): Promise<DraftCheckOutput> {
  const { store, blobs, ctx, scope } = deps;
  requireCapability(ctx, "data.render");
  const ruleset = CHECK_RULESETS[input.rulesetId];
  if (ruleset === undefined) {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `unknown rulesetId ${JSON.stringify(input.rulesetId)} — registered rulesets: ${Object.keys(CHECK_RULESETS).join(", ")}`,
    );
  }
  if (input.rulesetId !== "draft") {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `runDraftChecks only implements the "draft" ruleset`,
    );
  }
  if (input.baselineArtifactId !== undefined) {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      "the draft ruleset takes no baselineArtifactId — it lints a single compiled draft",
    );
  }
  assertDraftRegistry(deps.repoRoot, ruleset.checkIds);
  const subject = store.getArtifact(scope, input.artifactId);
  if (subject === null) {
    throw new WorkbenchError(ERROR_CODES.NOT_FOUND, `artifact ${input.artifactId} not found`);
  }
  if ((subject["kind"] as string) !== "pdf") {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `draft checks run against a compiled pdf artifact; ${input.artifactId} is ${subject["kind"]}`,
    );
  }
  const snapshotId = subject["snapshot_id"] as string;
  const targetId = (subject["target_id"] as string | null) ?? null;
  const buildJobId = subject["job_id"] as string;

  const out = await runServiceJob<Omit<DraftCheckOutput, "jobId">>({
    store,
    blobs,
    ctx,
    scope,
    jobs: deps.jobs,
    action: "checks.draft",
    snapshotId,
    targetId,
    input: { artifactId: input.artifactId, rulesetId: input.rulesetId, rulesetVersion: ruleset.version },
    compute: () => {
      const decoder = new TextDecoder("utf8", { fatal: false });
      const snapshotFiles = store.listSnapshotFiles(scope, snapshotId);
      const snapshotPaths = new Set(snapshotFiles.map((f) => f["path"] as string));
      const texts = new Map<string, string>();
      for (const f of snapshotFiles) {
        const p = f["path"] as string;
        if (/\.(tex|bib|bbl)$/i.test(p)) {
          texts.set(p, decoder.decode(blobs.getVerified(f["blob_hash"] as string)));
        }
      }
      let root: string | null = null;
      if (targetId !== null) {
        const targetRow = store.getTarget(scope, targetId);
        if (targetRow !== null) {
          try {
            root = (JSON.parse(targetRow["config_json"] as string) as Target).root ?? null;
          } catch {
            root = null;
          }
        }
      }
      const lint = lintDraftSources(texts, root);

      const build = buildResultOfJob(store, scope, buildJobId);
      let logText: string | null = null;
      let logArtifactId: string | null = null;
      const logId = build.buildResult?.logArtifactId;
      if (logId !== undefined && logId !== "") {
        const logRow = store.getArtifact(scope, logId);
        if (logRow !== null && (logRow["kind"] as string) === "log") {
          try {
            logText = decoder.decode(blobs.getVerified(logRow["blob_hash"] as string));
            logArtifactId = logId;
          } catch {
            logText = null;
          }
        }
      }
      const texLineCounts = new Map<string, number>();
      for (const [p, text] of texts) {
        if (/\.tex$/i.test(p)) texLineCounts.set(p, text.split("\n").length);
      }
      const buildLog = draftBuildLog(build, logText, snapshotPaths, texLineCounts);

      const inputDigest = digestJson({
        artifactId: input.artifactId,
        rulesetId: input.rulesetId,
        rulesetVersion: ruleset.version,
        snapshotId,
        buildJobId,
      });
      const now = utcNowIso();
      const toResult = (r: DraftLintResult, evidence: string[] = []): CheckResult => ({
        checkId: r.checkId,
        checkVersion: ruleset.version,
        inputDigest,
        status: r.status,
        severity: r.severity,
        scope: { paths: r.paths, pages: [], anchorIds: [input.artifactId] },
        findings: r.findings,
        evidenceArtifactIds: evidence,
        reviewerKind: r.status === "unsupported" ? "not-run" : "deterministic",
        checkedAt: now,
      });
      const byId = new Map<string, CheckResult>();
      for (const r of lint.results) byId.set(r.checkId, toResult(r));
      byId.set(
        "draft.build-log",
        toResult(
          { checkId: "draft.build-log", ...buildLog },
          logArtifactId !== null ? [logArtifactId] : [],
        ),
      );
      // Ruleset order; every ruleset id present exactly once.
      const results = ruleset.checkIds.map((id) => {
        const r = byId.get(id);
        if (r === undefined) {
          throw new WorkbenchError(ERROR_CODES.INVALID_REQUEST, `draft check ${id} produced no result`);
        }
        return r;
      });

      const blockingIds = results
        .filter((r) => r.status === "fail" && r.severity === "error")
        .map((r) => r.checkId);
      const missingReviewIds = results
        .filter((r) => r.status === "needs-review" || r.status === "unsupported")
        .map((r) => r.checkId);
      const report: CheckReport = {
        kind: "check-report",
        reportId: `cr-${randomUUID()}`,
        artifactId: input.artifactId,
        snapshotId,
        // Draft lint gates nothing.
        requiredCheckIds: [],
        results,
        // Source coverage: .tex files linted (reachable from the root) out
        // of all .tex files in the snapshot. No pages are reviewed.
        coverage: {
          pagesTotal: 0,
          pagesReviewed: [],
          trackedValues: lint.scannedPaths.length,
          candidateValues: lint.texFileCount,
        },
        blockingIds,
        missingReviewIds,
        inputDigest,
      };
      const bytes = utf8Bytes(canonicalJson(report));
      const blob = blobs.put(bytes);
      const reportArtifactId = `report-${blob.hash.slice(0, 16)}`;
      const now2 = utcNowIso();
      return {
        result: { report, reportArtifactId },
        publishExtra: () => {
          results.forEach((r, i) => {
            store.insertCheck(scope, {
              checkRunId: `${report.reportId}-${i}`,
              artifactId: input.artifactId,
              snapshotId,
              checkId: r.checkId,
              checkVersion: r.checkVersion,
              inputDigest: r.inputDigest,
              status: r.status,
              resultJson: canonicalJson(r),
              createdAt: now2,
            });
          });
        },
        artifacts: [
          {
            artifactId: reportArtifactId,
            relPath: `check-report-${report.reportId}.json`,
            kind: "report",
            blobHash: blob.hash,
            sizeBytes: bytes.length,
            mediaType: "application/json",
            manifestExtra: { pdfArtifactId: input.artifactId },
          } satisfies CollectedArtifact,
        ],
        evidence: [
          {
            snapshotId,
            kind: "check-report",
            sourceLocator: `artifact:${input.artifactId}`,
            content: bytes,
            accessStatus: "metadata-only",
            record: {
              reportId: report.reportId,
              rulesetId: input.rulesetId,
              requiredCheckIds: [],
              blockingIds,
              missingReviewIds,
            },
          },
        ],
      };
    },
  });
  return { ...out.result, jobId: out.jobId };
}
