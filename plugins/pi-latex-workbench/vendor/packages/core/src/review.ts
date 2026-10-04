/**
 * Page-review channel (M4): host-authenticated reviewers record per-page
 * verdicts against page-image artifacts. `human.review` is a host-only
 * capability — it is NOT in TOOL_CAPABILITIES, so no tool/model path can
 * reach this. Reviewer identity comes from the request context principal,
 * never from submitted parameters.
 *
 * Coverage is computed against the render manifest for the pdf: the pages a
 * release gate demands reviewed are exactly the pages the renderer emitted.
 * A review binds to the page-image artifact it inspected, but page identity
 * is (pdfArtifactId, page): re-rendering the same pdf at another preset or
 * in a check job produces new page-image artifacts, and a prior verdict on
 * the same pdf+page still counts (latest verdict wins). Reviews on page
 * images of a different pdf cannot inflate coverage.
 */
import {
  canonicalJson,
  digestJson,
  ERROR_CODES,
  utcNowIso,
  WorkbenchError,
} from "@latexwb/contracts";
import type { BlobStore, Row, Scope, WorkbenchStore } from "@latexwb/storage";
import { requireCapability } from "./capabilities.ts";
import type { RequestContext } from "./context.ts";
import { requireArtifact } from "./artifacts.ts";
import { recordEvidence } from "./evidence.ts";

export const REVIEW_VERDICTS = ["approved", "flagged"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export interface ReviewDeps {
  store: WorkbenchStore;
  blobs: BlobStore;
  ctx: RequestContext;
  scope: Scope;
}

export interface PageReviewRecord {
  reviewId: string;
  pageArtifactId: string;
  page: number;
  verdict: ReviewVerdict;
  note: string | null;
  reviewerId: string;
}

function manifestOf(row: Row): Record<string, unknown> {
  try {
    return JSON.parse(row["manifest_json"] as string) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The page number a page-image artifact renders — from its manifest row. */
export function pageOfArtifact(row: Row): number | null {
  const manifest = manifestOf(row);
  const page = manifest["page"];
  return typeof page === "number" && page >= 1 ? page : null;
}

/**
 * Record a host review of one page image. The verdict binds to the artifact
 * bytes: evidence content IS the page image, so `content_hash` proves what
 * the reviewer saw.
 */
export function submitPageReview(
  deps: ReviewDeps,
  input: { pageArtifactId: string; verdict: string; note?: string | undefined },
): PageReviewRecord {
  const { store, blobs, ctx, scope } = deps;
  requireCapability(ctx, "human.review");
  if (!REVIEW_VERDICTS.includes(input.verdict as ReviewVerdict)) {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `verdict must be one of ${REVIEW_VERDICTS.join(", ")} — got ${JSON.stringify(input.verdict)}`,
    );
  }
  const artifact = requireArtifact(store, scope, input.pageArtifactId);
  if ((artifact["kind"] as string) !== "page-image") {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `artifact ${input.pageArtifactId} is ${artifact["kind"]} — only page-image artifacts are reviewable`,
    );
  }
  const page = pageOfArtifact(artifact);
  if (page === null) {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_ARTIFACT,
      `page-image ${input.pageArtifactId} has no page number in its manifest`,
    );
  }
  const snapshotId = artifact["snapshot_id"] as string;
  const reviewId = `rev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const now = utcNowIso();
  const record: PageReviewRecord = {
    reviewId,
    pageArtifactId: input.pageArtifactId,
    page,
    verdict: input.verdict as ReviewVerdict,
    note: input.note ?? null,
    reviewerId: ctx.principalId,
  };
  store.insertReview(scope, {
    reviewId,
    artifactId: input.pageArtifactId,
    snapshotId,
    inputDigest: digestJson({ pageArtifactId: input.pageArtifactId, page }),
    reviewerId: ctx.principalId,
    reviewerKind: "human",
    resultJson: canonicalJson({
      page,
      verdict: record.verdict,
      note: record.note,
      reviewedAt: now,
    }),
    createdAt: now,
  });
  // Digest-bound evidence of what was reviewed: the image bytes themselves.
  recordEvidence({
    store,
    blobs,
    scope,
    input: {
      snapshotId,
      kind: "page-review",
      sourceLocator: `artifact:${input.pageArtifactId}`,
      content: blobs.getVerified(artifact["blob_hash"] as string),
      accessStatus: "fulltext",
      record: {
        reviewId,
        page,
        verdict: record.verdict,
        reviewerId: ctx.principalId,
        reviewedAt: now,
      },
    },
  });
  return record;
}

export interface PageCoverage {
  pdfArtifactId: string;
  pagesTotal: number;
  /** Pages with at least one review row (latest verdict wins). */
  pagesReviewed: number[];
  /** Pages whose LATEST review verdict is "flagged". */
  pagesFlagged: number[];
  /** Pages with no review row at all. */
  pagesUnreviewed: number[];
  /** The render manifest artifact this coverage is computed against. */
  manifestArtifactId: string | null;
}

/**
 * Page-image coverage of a pdf artifact: finds the latest render manifest
 * for the pdf (manifest artifacts carry pdfArtifactId in their record),
 * then each page's review state from the reviews table.
 */
export function pageReviewCoverage(
  store: WorkbenchStore,
  scope: Scope,
  pdfArtifactId: string,
): PageCoverage {
  const empty: PageCoverage = {
    pdfArtifactId,
    pagesTotal: 0,
    pagesReviewed: [],
    pagesFlagged: [],
    pagesUnreviewed: [],
    manifestArtifactId: null,
  };
  const pdf = store.getArtifact(scope, pdfArtifactId);
  if (pdf === null) return empty;
  const snapshotId = pdf["snapshot_id"] as string;

  // Latest render manifest for this pdf (manifest artifacts store the
  // render-manifest record in their blob; the row manifest carries the path).
  const manifests = store
    .listArtifactsBySnapshot(scope, snapshotId)
    .filter((a) => (a["kind"] as string) === "manifest")
    .filter((a) => (a["manifest_json"] as string).includes("render-manifest.json"));
  if (manifests.length === 0) return empty;
  // The newest manifest wins (later renders supersede) — but only manifests
  // whose job actually produced page-image artifacts are review targets.
  // Other jobs (e.g. release checks) publish render manifests for geometry/
  // font evidence without rasterizing pages; they must not zero coverage.
  let manifestRow: Row | null = null;
  let pageRows: Row[] = [];
  for (const candidate of manifests.slice().reverse()) {
    const rows = store
      .listArtifactsByJob(scope, candidate["job_id"] as string)
      .filter((a) => (a["kind"] as string) === "page-image");
    if (rows.length > 0) {
      manifestRow = candidate;
      pageRows = rows;
      break;
    }
  }
  if (manifestRow === null) return empty;

  const pagesReviewed: number[] = [];
  const pagesFlagged: number[] = [];
  const pagesUnreviewed: number[] = [];
  for (const pageRow of pageRows) {
    const page = pageOfArtifact(pageRow);
    if (page === null) continue;
    const reviews = store.listPageReviews(scope, pdfArtifactId, page);
    if (reviews.length === 0) {
      pagesUnreviewed.push(page);
      continue;
    }
    pagesReviewed.push(page);
    const latest = reviews.at(-1) as Row;
    const parsed = JSON.parse(latest["result_json"] as string) as { verdict?: string };
    if (parsed.verdict === "flagged") pagesFlagged.push(page);
  }
  return {
    pdfArtifactId,
    pagesTotal: pageRows.length,
    pagesReviewed: pagesReviewed.sort((a, b) => a - b),
    pagesFlagged: pagesFlagged.sort((a, b) => a - b),
    pagesUnreviewed: pagesUnreviewed.sort((a, b) => a - b),
    manifestArtifactId: manifestRow["artifact_id"] as string,
  };
}
