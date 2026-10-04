/**
 * Release pipeline (M4): freeze → whitelist → package → clean-room rebuild →
 * finalize. Every stage emits real artifacts/evidence; the release row's
 * manifest_json accumulates the frozen inputs and produced artifact ids.
 *
 * Honesty contract:
 *  - a blocked gate never produces a package — `blocked` ReleaseResults carry
 *    the codes that blocked it and no sourceZipArtifactId;
 *  - the clean-room rebuild runs the real runner against ONLY the staged
 *    zip's bytes — a mismatch is a blocking outcome, not a shrug;
 *  - approvals bind to digestJson({releaseId, whitelistDigest}) so a grant
 *    authorizes exactly the file set that gets packaged;
 *  - "submission-ready" is only emitted when every required check passed,
 *    every page is reviewed (when policy requires), the package grant exists,
 *    and the rebuild hash matched. Anything less is "review-ready" or
 *    "blocked" — release readiness is never inferred from compilation alone.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  digestJson,
  ERROR_CODES,
  sha256Hex,
  utf8Bytes,
  utcNowIso,
  WorkbenchError,
  type HostPolicy,
  type ReleasePlan,
  type ReleaseResult,
  type Target,
} from "@latexwb/contracts";
import type { BlobStore, Row, Scope, WorkbenchStore } from "@latexwb/storage";
import { requireCapability } from "./capabilities.ts";
import type { RequestContext } from "./context.ts";
import { requireArtifact, type CollectedArtifact } from "./artifacts.ts";
import { runServiceJob } from "./service-job.ts";
import type { JobService } from "./jobs.ts";
import { snapshotSourceDateEpoch, type BuildService } from "./build.ts";
import { runReleaseChecks } from "./checks.ts";
import { pageReviewCoverage } from "./review.ts";
import { readZip, writeDeterministicZip, type ZipEntryInput } from "./zip.ts";
import { inspectDerived, resolveTarget } from "./inspect.ts";
import { loadPreset, runnerForPreset, type Runner } from "@latexwb/runtime";

export interface ReleaseDeps {
  store: WorkbenchStore;
  blobs: BlobStore;
  ctx: RequestContext;
  scope: Scope;
  repoRoot: string;
  hostPolicy: HostPolicy | null;
  buildService: BuildService;
  jobs?: JobService;
}

export type ReleaseProfileId = "draft" | "review" | "submission";

/** Release approval action — the only action this module consults. */
export const RELEASE_PACKAGE_ACTION = "release.package";

interface OutputProfileRow {
  id: string;
  requiredCheckIds: string[];
}

// ---------------------------------------------------------------------------
// Whitelist
// ---------------------------------------------------------------------------

/** Path patterns that never ship in a release package. */
const DENY_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /(^|\/)\.[^/]+$/, reason: "hidden file" },
  { re: /(^|\/)\.latexwb(\/|$)/, reason: "workbench state directory" },
  { re: /(^|\/)(out|build|dist|target)\//, reason: "generated output directory" },
  { re: /\.(aux|log|out|toc|fls|fdb_latexmk|synctex\.gz|bbl|blg|xdv|nav|snm|vrb|run\.xml|bcf|mk)$/i, reason: "generated build artifact" },
  { re: /(^|\/)\.env($|\.)/, reason: "environment/secret file" },
  { re: /\.(pem|key|p12|pfx|jks|keystore)$/i, reason: "secret/credential material" },
  { re: /(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519|credentials|secrets?)(\.|$)/i, reason: "secret/credential material" },
];

export interface WhitelistResult {
  /** Snapshot-relative paths admitted to the package (sorted). */
  paths: string[];
  excluded: Array<{ path: string; reason: string }>;
}

/**
 * The release source whitelist: snapshot files minus generated/hidden/secret
 * paths. Fail-closed — a file is admitted only when no deny rule matches, and
 * every exclusion is recorded with its reason.
 */
export function computeWhitelist(
  store: WorkbenchStore,
  scope: Scope,
  snapshotId: string,
): WhitelistResult {
  const files = store.listSnapshotFiles(scope, snapshotId);
  const paths: string[] = [];
  const excluded: WhitelistResult["excluded"] = [];
  for (const f of files) {
    const path = f["path"] as string;
    const deny = DENY_PATTERNS.find((d) => d.re.test(path));
    if (deny !== undefined) {
      excluded.push({ path, reason: deny.reason });
    } else {
      paths.push(path);
    }
  }
  paths.sort();
  return { paths, excluded };
}

/** sha256 of the canonical whitelist record — what the approval binds to. */
export function whitelistDigest(whitelist: WhitelistResult, snapshotId: string, targetId: string): string {
  return sha256Hex(
    utf8Bytes(
      canonicalJson({
        kind: "release-whitelist",
        snapshotId,
        targetId,
        paths: whitelist.paths,
        excluded: whitelist.excluded,
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Freeze
// ---------------------------------------------------------------------------

/**
 * Resolve the release target: the persisted row when present, otherwise the
 * same inspection/derivation the build service uses — freeze runs BEFORE the
 * clean build in the release workflow, so the row may not exist yet. When we
 * derive it we persist the row so freeze→build→rebuild all pin one target.
 */
function resolveReleaseTarget(
  deps: ReleaseDeps,
  snapshotId: string,
  targetId: string,
): Target {
  const { store, blobs, scope } = deps;
  const existing = store.getTarget(scope, targetId);
  if (existing !== null) {
    return JSON.parse(existing["config_json"] as string) as Target;
  }
  const existingTargets = store
    .listTargets(scope)
    .map((r) => JSON.parse(r["config_json"] as string) as Target);
  const { inspection, derived } = inspectDerived({
    store,
    blobs,
    scope,
    snapshotId,
    projectId: scope.projectId,
    existingTargets,
  });
  // Derive (requestedTargetId null → resolveTarget inspects the snapshot);
  // the derived id must match the one the caller froze.
  const target = resolveTarget(inspection, derived, {
    requestedTargetId: null,
    engineFallback: "xelatex",
    presetForEngine: (engine) =>
      engine === "xelatex" ? "local-tectonic-xelatex" : `docker-texlive-${engine}`,
  });
  if (target === null || target.id !== targetId) {
    throw new WorkbenchError(
      ERROR_CODES.NOT_FOUND,
      `target ${targetId} not found and could not be derived from snapshot ${snapshotId}`,
    );
  }
  const targetJson = canonicalJson(target);
  store.putTarget(scope, target.id, targetJson, digestJson(target));
  return target;
}

function outputProfile(deps: ReleaseDeps, target: Target): OutputProfileRow | null {
  const path = join(deps.repoRoot, "resources", "profiles", "outputs", `${target.outputProfileId}.json`);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as OutputProfileRow;
  } catch {
    return null;
  }
}

/**
 * Freeze a release: pin (snapshot, target, profile) into a releases row with
 * status "draft" + persist the ReleasePlan as a manifest artifact — all inside
 * one durable service job (the release row lands in the finalize transaction,
 * so a freeze either fully happened or did not). The PDF is NOT frozen here —
 * it arrives from the clean build step downstream.
 */
export async function freezeRelease(
  deps: ReleaseDeps,
  input: {
    snapshotId: string;
    targetId: string;
    releaseProfileId: ReleaseProfileId;
    pdfArtifactId?: string | undefined;
  },
): Promise<{ releaseId: string; plan: ReleasePlan; jobId: string }> {
  const { store, blobs, ctx, scope } = deps;
  requireCapability(ctx, "release.create");
  const snapshot = store.getSnapshot(scope, input.snapshotId);
  if (snapshot === null) {
    throw new WorkbenchError(ERROR_CODES.NOT_FOUND, `snapshot ${input.snapshotId} not found`);
  }
  const target = resolveReleaseTarget(deps, input.snapshotId, input.targetId);
  const profile = outputProfile(deps, target);
  const whitelist = computeWhitelist(store, scope, input.snapshotId);

  const plan: ReleasePlan = {
    kind: "release-plan",
    snapshotId: input.snapshotId,
    targetId: input.targetId,
    candidatePaths: whitelist.paths,
    requiredCheckIds: profile?.requiredCheckIds ?? [],
    requiredApprovals: [RELEASE_PACKAGE_ACTION],
    blockingCodes: [],
  };

  const out = await runServiceJob<{ releaseId: string; plan: ReleasePlan }>({
    store,
    blobs,
    ctx,
    scope,
    jobs: deps.jobs,
    action: "release.freeze",
    snapshotId: input.snapshotId,
    targetId: input.targetId,
    input,
    compute: (jobId) => {
      void jobId;
      const releaseId = `rel-${randomUUID()}`;
      const manifest = {
        schemaVersion: 1,
        releaseId,
        releaseProfileId: input.releaseProfileId,
        plan,
        whitelistExcluded: whitelist.excluded,
        frozenBy: ctx.principalId,
        policyId: ctx.policyId,
        frozenAt: utcNowIso(),
        ...(input.pdfArtifactId !== undefined ? { pdfArtifactId: input.pdfArtifactId } : {}),
      };
      const planBytes = utf8Bytes(canonicalJson(plan));
      const blob = blobs.put(planBytes);
      return {
        result: { releaseId, plan },
        artifacts: [
          {
            artifactId: `manifest-${blob.hash.slice(0, 16)}`,
            relPath: "release-plan.json",
            kind: "manifest",
            blobHash: blob.hash,
            sizeBytes: planBytes.length,
            mediaType: "application/json",
            manifestExtra: { releaseId },
          },
        ],
        publishExtra: () => {
          store.insertRelease(scope, {
            releaseId,
            snapshotId: input.snapshotId,
            targetId: input.targetId,
            status: "draft",
            manifestJson: canonicalJson(manifest),
            createdAt: utcNowIso(),
          });
        },
      };
    },
  });
  return { releaseId: out.result.releaseId, plan: out.result.plan, jobId: out.jobId };
}

/**
 * `latex_export prepare` — plan only, no freeze: the ReleasePlan is computed
 * and persisted as a manifest artifact so the preview is auditable.
 */
export async function prepareRelease(
  deps: ReleaseDeps,
  input: {
    snapshotId: string;
    targetId: string;
    releaseProfileId: ReleaseProfileId;
  },
): Promise<{ plan: ReleasePlan; planArtifactId: string; jobId: string }> {
  const { store, blobs, ctx, scope } = deps;
  requireCapability(ctx, "release.create");
  const target = resolveReleaseTarget(deps, input.snapshotId, input.targetId);
  const profile = outputProfile(deps, target);
  const whitelist = computeWhitelist(store, scope, input.snapshotId);
  const plan: ReleasePlan = {
    kind: "release-plan",
    snapshotId: input.snapshotId,
    targetId: input.targetId,
    candidatePaths: whitelist.paths,
    requiredCheckIds: profile?.requiredCheckIds ?? [],
    requiredApprovals: [RELEASE_PACKAGE_ACTION],
    blockingCodes: [],
  };
  const out = await runServiceJob<{ planArtifactId: string }>({
    store,
    blobs,
    ctx,
    scope,
    jobs: deps.jobs,
    action: "release.plan",
    snapshotId: input.snapshotId,
    targetId: input.targetId,
    input,
    compute: () => {
      const bytes = utf8Bytes(canonicalJson(plan));
      const blob = blobs.put(bytes);
      const planArtifactId = `manifest-${blob.hash.slice(0, 16)}`;
      return {
        result: { planArtifactId },
        artifacts: [
          {
            artifactId: planArtifactId,
            relPath: "release-plan.json",
            kind: "manifest",
            blobHash: blob.hash,
            sizeBytes: bytes.length,
            mediaType: "application/json",
          },
        ],
        evidence: [
          {
            snapshotId: input.snapshotId,
            kind: "release-plan",
            sourceLocator: `target:${input.targetId}`,
            content: bytes,
            accessStatus: "fulltext",
            record: { plan },
          },
        ],
      };
    },
  });
  return { plan, planArtifactId: out.result.planArtifactId, jobId: out.jobId };
}

// ---------------------------------------------------------------------------
// Package + rebuild + finalize
// ---------------------------------------------------------------------------

function requireRelease(store: WorkbenchStore, scope: Scope, releaseId: string): Row {
  const row = store.getRelease(scope, releaseId);
  if (row === null) {
    throw new WorkbenchError(ERROR_CODES.NOT_FOUND, `release ${releaseId} not found`);
  }
  return row;
}

function releaseManifest(row: Row): {
  releaseProfileId: ReleaseProfileId;
  plan: ReleasePlan;
  [k: string]: unknown;
} {
  return JSON.parse(row["manifest_json"] as string) as ReturnType<typeof releaseManifest>;
}

export interface GateOutcome {
  blockingCodes: string[];
  reportArtifactIds: string[];
  pageArtifactIds: string[];
  checkReportArtifactId: string | null;
}

/** Run the check suite + coverage evaluation; returns gate facts. */
export async function evaluateReleaseGates(
  deps: ReleaseDeps,
  input: {
    releaseId: string;
    snapshotId: string;
    targetId: string;
    releaseProfileId: ReleaseProfileId;
    pdfArtifactId: string;
    baselineArtifactId?: string | undefined;
  },
): Promise<GateOutcome> {
  const { store, scope } = deps;
  const blockingCodes: string[] = [];
  const reportArtifactIds: string[] = [];

  const checks = await runReleaseChecks(
    {
      store: deps.store,
      blobs: deps.blobs,
      ctx: deps.ctx,
      scope: deps.scope,
      ...(deps.jobs !== undefined ? { jobs: deps.jobs } : {}),
      hostPolicy: deps.hostPolicy,
      repoRoot: deps.repoRoot,
    },
    {
      artifactId: input.pdfArtifactId,
      rulesetId: "release",
      releaseProfileId: input.releaseProfileId,
      ...(input.baselineArtifactId !== undefined
        ? { baselineArtifactId: input.baselineArtifactId }
        : {}),
    },
  );
  reportArtifactIds.push(checks.reportArtifactId);
  for (const id of checks.report.blockingIds) {
    blockingCodes.push(`check.${id}`);
  }

  const coverage = pageReviewCoverage(store, scope, input.pdfArtifactId);
  const requireAll = deps.hostPolicy?.requireAllReleasePagesReviewed === true;
  if (requireAll) {
    if (coverage.pagesTotal === 0) {
      blockingCodes.push("review.no-rendered-pages");
    } else {
      // Per-page codes: a comma-joined list would violate the
      // blockingCodes contract pattern and invalidate the envelope.
      for (const page of coverage.pagesUnreviewed) {
        blockingCodes.push(`review.pages-unreviewed:${page}`);
      }
      for (const page of coverage.pagesFlagged) {
        blockingCodes.push(`review.pages-flagged:${page}`);
      }
    }
  } else {
    for (const page of coverage.pagesFlagged) {
      blockingCodes.push(`review.pages-flagged:${page}`);
    }
  }
  return {
    blockingCodes,
    reportArtifactIds,
    pageArtifactIds: checks.pageArtifactIds,
    checkReportArtifactId: checks.reportArtifactId,
  };
}

interface PackageArtifacts {
  /** Ready-to-insert artifact rows (blobs already in CAS). */
  staged: CollectedArtifact[];
  zipArtifactId: string;
  manifestArtifactId: string;
  whitelistDigest: string;
  zipSha256: string;
}

/** Build the deterministic source zip + package manifest artifacts. */
function buildPackageArtifacts(
  deps: ReleaseDeps,
  input: {
    releaseId: string;
    snapshotId: string;
    targetId: string;
  },
): PackageArtifacts {
  const { store, blobs, scope } = deps;
  const whitelist = computeWhitelist(store, scope, input.snapshotId);
  const wd = whitelistDigest(whitelist, input.snapshotId, input.targetId);
  const fileRows = store.listSnapshotFiles(scope, input.snapshotId);

  const entries: ZipEntryInput[] = whitelist.paths.map((path) => {
    const row = fileRows.find((f) => (f["path"] as string) === path);
    if (row === undefined) {
      throw new WorkbenchError(
        ERROR_CODES.NOT_FOUND,
        `whitelist names ${path} but it is not a file of snapshot ${input.snapshotId}`,
      );
    }
    return { name: path, data: Buffer.from(blobs.getVerified(row["blob_hash"] as string)) };
  });
  const zipBytes = writeDeterministicZip(entries);
  const zipBlob = blobs.put(zipBytes);
  const zipArtifactId = `source-zip-${zipBlob.hash.slice(0, 16)}`;

  const manifest = {
    schemaVersion: 1,
    kind: "release-package-manifest",
    releaseId: input.releaseId,
    snapshotId: input.snapshotId,
    targetId: input.targetId,
    whitelistDigest: wd,
    sourceZipSha256: zipBlob.hash,
    files: whitelist.paths.map((path) => {
      const row = fileRows.find((f) => (f["path"] as string) === path) as Row;
      return { path, sha256: row["blob_hash"] as string, bytes: row["size_bytes"] as number };
    }),
    excluded: whitelist.excluded,
  };
  const manifestBytes = utf8Bytes(canonicalJson(manifest));
  const manifestBlob = blobs.put(manifestBytes);
  const manifestArtifactId = `manifest-${manifestBlob.hash.slice(0, 16)}`;

  return {
    zipArtifactId,
    manifestArtifactId,
    whitelistDigest: wd,
    zipSha256: zipBlob.hash,
    staged: [
      {
        artifactId: zipArtifactId,
        relPath: "source.zip",
        kind: "source-zip",
        blobHash: zipBlob.hash,
        sizeBytes: zipBytes.length,
        mediaType: "application/zip",
        manifestExtra: { releaseId: input.releaseId, whitelistDigest: wd },
      },
      {
        artifactId: manifestArtifactId,
        relPath: "package-manifest.json",
        kind: "manifest",
        blobHash: manifestBlob.hash,
        sizeBytes: manifestBytes.length,
        mediaType: "application/json",
        manifestExtra: { releaseId: input.releaseId },
      },
    ],
  };
}

export interface RebuildOutcome {
  verified: boolean;
  rebuildJobId: string;
  expectedSha256: string;
  actualSha256: string | null;
  reportArtifactId: string;
  detail: string;
}

/**
 * Clean-room rebuild: extract the staged zip into a fresh directory, run the
 * real runner for the target's preset, and sha256-compare the produced pdf
 * against the staged pdf bytes. This job SUCCEEDS with verified=false when
 * the bytes differ — a mismatch is a release outcome, not a job error.
 */
export async function rebuildPackage(
  deps: ReleaseDeps,
  input: {
    releaseId: string;
    snapshotId: string;
    target: Target;
    zipArtifactId: string;
    pdfArtifactId: string;
  },
): Promise<RebuildOutcome> {
  const { store, blobs, scope } = deps;
  const zipRow = requireArtifact(store, scope, input.zipArtifactId);
  const pdfRow = requireArtifact(store, scope, input.pdfArtifactId);
  const expectedSha = pdfRow["blob_hash"] as string;

  const out = await runServiceJob<Omit<RebuildOutcome, "rebuildJobId">>({
    store,
    blobs,
    ctx: deps.ctx,
    scope,
    jobs: deps.jobs,
    action: "release.rebuild",
    snapshotId: input.snapshotId,
    targetId: input.target.id,
    input: {
      releaseId: input.releaseId,
      zipArtifactId: input.zipArtifactId,
      pdfArtifactId: input.pdfArtifactId,
    },
    compute: async (jobId) => {
      const workDir = mkdtempSync(join(tmpdir(), `latexwb-rebuild-${jobId}-`));
      try {
        const srcDir = join(workDir, "src");
        const outDir = join(workDir, "out");
        const scratchDir = join(workDir, "scratch");
        mkdirSync(srcDir, { recursive: true });
        mkdirSync(outDir, { recursive: true });
        mkdirSync(scratchDir, { recursive: true });

        // Extract ONLY the staged zip — nothing else enters the clean room.
        const zipBytes = blobs.getVerified(zipRow["blob_hash"] as string);
        for (const entry of readZip(Buffer.from(zipBytes))) {
          const dest = join(srcDir, entry.name);
          const resolved = join(srcDir, entry.name);
          if (!resolved.startsWith(srcDir + "/") && resolved !== srcDir) {
            throw new WorkbenchError(
              ERROR_CODES.UNSUPPORTED_PATH,
              `zip entry escapes staging root: ${entry.name}`,
            );
          }
          mkdirSync(dirname(dest), { recursive: true });
          writeFileSync(dest, entry.data);
        }

        const preset = loadPreset(
          join(deps.repoRoot, "runtime", "presets"),
          input.target.buildPresetId,
        );
        const runner: Runner = runnerForPreset(deps.buildService.runnerMap(), preset);
        const runWorkDir =
          input.target.workingDirectory === "entry-parent"
            ? join(srcDir, dirname(input.target.root))
            : srcDir;
        const entryFile =
          input.target.workingDirectory === "entry-parent"
            ? basename(input.target.root)
            : input.target.root;
        const rr = await runner.run({
          jobId,
          workDir: runWorkDir,
          entryFile,
          engine: input.target.engine,
          bibliographyMode: input.target.bibliography,
          outputDir: outDir,
          scratchDir,
          preset,
          // Same content-derived clock as the build that produced the staged
          // PDF — the sha256 comparison below depends on it.
          sourceDateEpoch: snapshotSourceDateEpoch(store, scope, pdfRow["snapshot_id"] as string),
        });

        const entryBase = basename(input.target.root).replace(/\.[^.]+$/, "");
        const rebuiltPath = join(outDir, `${entryBase}.pdf`);
        let actualSha: string | null = null;
        let verified = false;
        let detail: string;
        let rebuiltBytes: Uint8Array | null = null;
        if (rr.exitCode !== 0) {
          detail = `rebuild exited ${rr.exitCode ?? "signal"} — package does not compile cleanly`;
        } else if (!existsSync(rebuiltPath)) {
          detail = `rebuild produced no ${entryBase}.pdf`;
        } else {
          rebuiltBytes = readFileSync(rebuiltPath);
          actualSha = sha256Hex(rebuiltBytes);
          verified = actualSha === expectedSha;
          detail = verified
            ? `clean-room rebuild sha256 matches staged pdf (${actualSha.slice(0, 16)}…)`
            : `rebuild sha256=${actualSha.slice(0, 16)}… != staged pdf ${expectedSha.slice(0, 16)}…`;
        }

        const report = canonicalJson({
          kind: "release-rebuild",
          releaseId: input.releaseId,
          zipArtifactId: input.zipArtifactId,
          pdfArtifactId: input.pdfArtifactId,
          expectedSha256: expectedSha,
          actualSha256: actualSha,
          verified,
          exitCode: rr.exitCode,
          durationMs: rr.durationMs,
          detail,
        });
        const reportBytes = utf8Bytes(report);
        const reportBlob = blobs.put(reportBytes);
        const reportArtifactId = `report-${reportBlob.hash.slice(0, 16)}`;
        const artifacts: CollectedArtifact[] = [
          {
            artifactId: reportArtifactId,
            relPath: "rebuild-report.json",
            kind: "report",
            blobHash: reportBlob.hash,
            sizeBytes: reportBytes.length,
            mediaType: "application/json",
          },
        ];
        return {
          result: { verified, expectedSha256: expectedSha, actualSha256: actualSha, reportArtifactId, detail },
          artifacts,
          evidence: [
            {
              snapshotId: input.snapshotId,
              kind: "release-rebuild",
              sourceLocator: `artifact:${input.zipArtifactId}`,
              // The OBSERVED bytes: the rebuilt pdf (or the failure report).
              content: rebuiltBytes ?? reportBytes,
              accessStatus: "fulltext",
              record: {
                releaseId: input.releaseId,
                verified,
                expectedSha256: expectedSha,
                actualSha256: actualSha,
                detail,
              },
            },
          ],
        };
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    },
  });
  return { ...out.result, rebuildJobId: out.jobId };
}

/**
 * `release.prepare-whitelist`: persist the whitelist as a manifest artifact
 * (audit trail of exactly what will ship, before any approval is consulted).
 */
export async function stageWhitelist(
  deps: ReleaseDeps,
  input: { releaseId: string },
): Promise<{ whitelistArtifactId: string; whitelistDigest: string; jobId: string }> {
  const { store, blobs, ctx, scope } = deps;
  requireCapability(ctx, "release.create");
  const release = requireRelease(store, scope, input.releaseId);
  const snapshotId = release["snapshot_id"] as string;
  const targetId = release["target_id"] as string;

  const out = await runServiceJob<{ whitelistArtifactId: string; whitelistDigest: string }>({
    store,
    blobs,
    ctx,
    scope,
    jobs: deps.jobs,
    action: "release.whitelist",
    snapshotId,
    targetId,
    input,
    compute: () => {
      const whitelist = computeWhitelist(store, scope, snapshotId);
      const wd = whitelistDigest(whitelist, snapshotId, targetId);
      const fileRows = store.listSnapshotFiles(scope, snapshotId);
      const record = {
        schemaVersion: 1,
        kind: "release-whitelist",
        releaseId: input.releaseId,
        snapshotId,
        targetId,
        whitelistDigest: wd,
        files: whitelist.paths.map((path) => {
          const row = fileRows.find((f) => (f["path"] as string) === path) as Row;
          return {
            path,
            sha256: row["blob_hash"] as string,
            bytes: row["size_bytes"] as number,
            role: (row["role"] as string) ?? null,
          };
        }),
        excluded: whitelist.excluded,
      };
      const bytes = utf8Bytes(canonicalJson(record));
      const blob = blobs.put(bytes);
      const whitelistArtifactId = `manifest-${blob.hash.slice(0, 16)}`;
      return {
        result: { whitelistArtifactId, whitelistDigest: wd },
        artifacts: [
          {
            artifactId: whitelistArtifactId,
            relPath: "release-whitelist.json",
            kind: "manifest",
            blobHash: blob.hash,
            sizeBytes: bytes.length,
            mediaType: "application/json",
            manifestExtra: { releaseId: input.releaseId, whitelistDigest: wd },
          },
        ],
        evidence: [
          {
            snapshotId,
            kind: "release-whitelist",
            sourceLocator: `release:${input.releaseId}`,
            content: bytes,
            accessStatus: "fulltext",
            record: { releaseId: input.releaseId, whitelistDigest: wd, files: whitelist.paths.length },
          },
        ],
      };
    },
  });
  return { ...out.result, jobId: out.jobId };
}

/**
 * `release.package-staging`: deterministic source zip + package manifest as
 * artifacts. Requires the whitelist already staged for THIS release — the
 * staged whitelist digest is what the approval binds to, so packaging from a
 * different whitelist must not silently succeed.
 */
export async function stagePackage(
  deps: ReleaseDeps,
  input: { releaseId: string },
): Promise<{ sourceZipArtifactId: string; packageManifestArtifactId: string; jobId: string }> {
  const { store, blobs, ctx, scope } = deps;
  requireCapability(ctx, "release.create");
  const release = requireRelease(store, scope, input.releaseId);
  const snapshotId = release["snapshot_id"] as string;
  const targetId = release["target_id"] as string;

  const out = await runServiceJob<{
    sourceZipArtifactId: string;
    packageManifestArtifactId: string;
  }>({
    store,
    blobs,
    ctx,
    scope,
    jobs: deps.jobs,
    action: "release.package-stage",
    snapshotId,
    targetId,
    input,
    compute: () => {
      const staged = buildPackageArtifacts(deps, {
        releaseId: input.releaseId,
        snapshotId,
        targetId,
      });
      return {
        result: {
          sourceZipArtifactId: staged.zipArtifactId,
          packageManifestArtifactId: staged.manifestArtifactId,
        },
        artifacts: staged.staged,
        evidence: [
          {
            snapshotId,
            kind: "release-package",
            sourceLocator: `release:${input.releaseId}`,
            content: blobs.getVerified(staged.zipSha256),
            accessStatus: "fulltext",
            record: {
              releaseId: input.releaseId,
              sourceZipArtifactId: staged.zipArtifactId,
              sourceZipSha256: staged.zipSha256,
              whitelistDigest: staged.whitelistDigest,
            },
          },
        ],
      };
    },
  });
  return { ...out.result, jobId: out.jobId };
}

/**
 * `release.finalize`: the authoritative status computation. Re-runs the gate
 * evaluation (the check job dedups to the earlier run — inputs are pinned),
 * re-checks the approval grant and rebuild verdict AT THIS MOMENT, then
 * updates the release row and emits the ReleaseResult artifact inside one
 * transaction.
 */
export async function finalizeRelease(
  deps: ReleaseDeps,
  input: {
    releaseId: string;
    pdfArtifactId: string;
    sourceZipArtifactId?: string | undefined;
    rebuildJobId?: string | undefined;
    baselineArtifactId?: string | undefined;
  },
): Promise<{ result: ReleaseResult; jobId: string }> {
  const { store, blobs, ctx, scope } = deps;
  requireCapability(ctx, "release.create");
  const release = requireRelease(store, scope, input.releaseId);
  const snapshotId = release["snapshot_id"] as string;
  const targetId = release["target_id"] as string;
  const manifest = releaseManifest(release);
  const releaseProfileId = manifest.releaseProfileId;
  requireArtifact(store, scope, input.pdfArtifactId);

  // Everything the status decision reads belongs to the dedup input — a
  // changed grant, review or rebuild verdict must land a NEW finalize job.
  const coverageNow = pageReviewCoverage(store, scope, input.pdfArtifactId);
  const approvalDigest = releaseApprovalDigest(input.releaseId, snapshotId, targetId, store, scope);
  const usableNow = store.findUsableApproval(
    scope, RELEASE_PACKAGE_ACTION, approvalDigest, snapshotId, ctx.policyId, utcNowIso(),
  );
  const gateDigest = digestJson({
    releaseId: input.releaseId,
    pdfArtifactId: input.pdfArtifactId,
    sourceZipArtifactId: input.sourceZipArtifactId ?? null,
    rebuildJobId: input.rebuildJobId ?? null,
    baselineArtifactId: input.baselineArtifactId ?? null,
    reviews: coverageNow.pagesReviewed.map(
      (p) => `${p}:${coverageNow.pagesFlagged.includes(p) ? "flagged" : "approved"}`,
    ),
    pagesTotal: coverageNow.pagesTotal,
    approval: usableNow?.["approval_id"] ?? null,
  });

  const out = await runServiceJob<ReleaseResult>({
    store,
    blobs,
    ctx,
    scope,
    jobs: deps.jobs,
    action: "release.finalize",
    snapshotId,
    targetId,
    input: { ...input, gateDigest },
    compute: async (jobId) => {
      const gates = await evaluateReleaseGates(deps, {
        releaseId: input.releaseId,
        snapshotId,
        targetId,
        releaseProfileId,
        pdfArtifactId: input.pdfArtifactId,
        ...(input.baselineArtifactId !== undefined
          ? { baselineArtifactId: input.baselineArtifactId }
          : {}),
      });
      const blockingCodes = [...gates.blockingCodes];
      const reportArtifactIds = [...gates.reportArtifactIds];

      const usable = store.findUsableApproval(
        scope, RELEASE_PACKAGE_ACTION, approvalDigest, snapshotId, ctx.policyId, utcNowIso(),
      );
      if (usable === null) {
        blockingCodes.push(`approval.${RELEASE_PACKAGE_ACTION}`);
      }

      // Rebuild verdict — read the recorded job result (never re-derived).
      let rebuildJobId: string | null = input.rebuildJobId ?? null;
      if (input.rebuildJobId !== undefined) {
        const jobRow = store.getJob(scope, input.rebuildJobId);
        const parsed = jobRow === null
          ? null
          : (JSON.parse((jobRow["result_json"] as string) ?? "{}") as {
              result?: { verified?: boolean; reportArtifactId?: string };
            }).result ?? null;
        if (parsed === null || parsed.verified !== true) {
          blockingCodes.push("rebuild.mismatch");
        }
        if (parsed?.reportArtifactId !== undefined) {
          reportArtifactIds.push(parsed.reportArtifactId);
        }
      } else {
        blockingCodes.push("rebuild.not-run");
      }
      if (input.sourceZipArtifactId === undefined) {
        blockingCodes.push("package.not-staged");
      }

      const status: ReleaseResult["status"] =
        blockingCodes.length > 0
          ? "blocked"
          : releaseProfileId === "submission"
            ? "submission-ready"
            : "review-ready";

      const result: ReleaseResult = {
        kind: "release-result",
        releaseId: input.releaseId,
        snapshotId,
        targetId,
        status,
        pdfArtifactId: input.pdfArtifactId,
        sourceZipArtifactId: input.sourceZipArtifactId ?? null,
        reportArtifactIds,
        rebuildJobId,
        blockingCodes,
      };

      const resultBytes = utf8Bytes(canonicalJson(result));
      const resultBlob = blobs.put(resultBytes);
      const resultArtifactId = `manifest-${resultBlob.hash.slice(0, 16)}`;
      return {
        result,
        artifacts: [
          {
            artifactId: resultArtifactId,
            relPath: "release-result.json",
            kind: "manifest",
            blobHash: resultBlob.hash,
            sizeBytes: resultBytes.length,
            mediaType: "application/json",
            manifestExtra: { releaseId: input.releaseId },
          },
        ],
        publishExtra: () => {
          // The release row updates inside the same finalize transaction as
          // the artifacts — the manifest always reflects produced ids.
          const existing = releaseManifest(requireRelease(store, scope, input.releaseId));
          store.updateRelease(scope, input.releaseId, {
            status,
            manifestJson: canonicalJson({
              ...existing,
              pdfArtifactId: input.pdfArtifactId,
              sourceZipArtifactId: input.sourceZipArtifactId ?? null,
              result,
              finalizedAt: utcNowIso(),
            }),
          });
        },
        evidence: [
          {
            snapshotId,
            kind: "release-result",
            sourceLocator: `release:${input.releaseId}`,
            content: resultBytes,
            accessStatus: "fulltext",
            record: {
              releaseId: input.releaseId,
              status,
              blockingCodes,
              finalizeJobId: jobId,
            },
          },
        ],
      };
    },
  });
  return { result: out.result, jobId: out.jobId };
}

/**
 * `latex_export package` — the whole pipeline for a frozen release in one
 * call: gates → approval → stage → rebuild → finalize. A blocked gate does
 * not throw — the pipeline still finalizes (to "blocked") so the ReleaseResult
 * and release row name exactly what was missing.
 */
export async function packageRelease(
  deps: ReleaseDeps,
  input: {
    releaseId: string;
    pdfArtifactId: string;
    baselineArtifactId?: string | undefined;
  },
): Promise<{ result: ReleaseResult; jobId: string }> {
  const { store, ctx, scope } = deps;
  requireCapability(ctx, "release.create");
  const release = requireRelease(store, scope, input.releaseId);
  const snapshotId = release["snapshot_id"] as string;
  const targetId = release["target_id"] as string;
  const manifest = releaseManifest(release);
  const target = resolveReleaseTarget(deps, snapshotId, targetId);
  requireArtifact(store, scope, input.pdfArtifactId);

  const gates = await evaluateReleaseGates(deps, {
    releaseId: input.releaseId,
    snapshotId,
    targetId,
    releaseProfileId: manifest.releaseProfileId,
    pdfArtifactId: input.pdfArtifactId,
    ...(input.baselineArtifactId !== undefined
      ? { baselineArtifactId: input.baselineArtifactId }
      : {}),
  });

  const approvalDigest = releaseApprovalDigest(input.releaseId, snapshotId, targetId, store, scope);
  const usable = store.findUsableApproval(
    scope, RELEASE_PACKAGE_ACTION, approvalDigest, snapshotId, ctx.policyId, utcNowIso(),
  );

  let sourceZipArtifactId: string | undefined;
  let rebuildJobId: string | undefined;
  if (gates.blockingCodes.length === 0 && usable !== null) {
    await stageWhitelist(deps, { releaseId: input.releaseId });
    const staged = await stagePackage(deps, { releaseId: input.releaseId });
    sourceZipArtifactId = staged.sourceZipArtifactId;
    const rebuild = await rebuildPackage(deps, {
      releaseId: input.releaseId,
      snapshotId,
      target,
      zipArtifactId: staged.sourceZipArtifactId,
      pdfArtifactId: input.pdfArtifactId,
    });
    rebuildJobId = rebuild.rebuildJobId;
  }
  return finalizeRelease(deps, {
    releaseId: input.releaseId,
    pdfArtifactId: input.pdfArtifactId,
    ...(sourceZipArtifactId !== undefined ? { sourceZipArtifactId } : {}),
    ...(rebuildJobId !== undefined ? { rebuildJobId } : {}),
    ...(input.baselineArtifactId !== undefined
      ? { baselineArtifactId: input.baselineArtifactId }
      : {}),
  });
}

/** The digest a 'release.package' approval is bound to. */
export function releaseApprovalDigest(
  releaseId: string,
  snapshotId: string,
  targetId: string,
  store: WorkbenchStore,
  scope: Scope,
): string {
  const whitelist = computeWhitelist(store, scope, snapshotId);
  return digestJson({
    action: RELEASE_PACKAGE_ACTION,
    releaseId,
    snapshotId,
    targetId,
    whitelistDigest: whitelistDigest(whitelist, snapshotId, targetId),
  });
}
