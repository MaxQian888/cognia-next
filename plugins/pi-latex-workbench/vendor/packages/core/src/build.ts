/**
 * Build orchestration (M1): snapshot → target → runner → diagnostics →
 * artifacts → job lifecycle, all persisted through the scoped store.
 *
 * Cache: buildKey = hash(treeHash + resolved target + toolchainDigest +
 * presetId + runner-capability summary). Only jobs that reached state
 * 'succeeded' AND produced a 'compiled' BuildResult satisfy a lookup —
 * failed/cancelled/lost/timed-out runs are never cache hits. A hit creates
 * a NEW job row whose BuildResult reuses the original artifact ids;
 * artifact created_at is never rewritten.
 */
import { mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  canonicalJson,
  digestJson,
  sha256Hex,
  ERROR_CODES,
  utcNowIso,
  WorkbenchError,
  type BuildPreset,
  type BuildResult,
  type Diagnostic,
  type JobResult,
  type Target,
} from "@latexwb/contracts";
import {
  createRunners,
  loadPreset,
  runnerForPreset,
  type Runner,
  type RunnerCapabilities,
  type RunnerResult,
} from "@latexwb/runtime";
import {
  type BlobStore,
  type Scope,
  type WorkbenchStore,
} from "@latexwb/storage";
import { requireCapability } from "./capabilities.ts";
import type { RequestContext } from "./context.ts";
import {
  collectArtifacts,
  insertArtifactRows,
  artifactRefOf,
  type CollectedArtifact,
} from "./artifacts.ts";
import { parseTexLog, parseRunnerStderr } from "./diagnostics.ts";
import { inspectDerived, resolveTarget } from "./inspect.ts";
import { runIdempotent } from "./idempotency.ts";
import { JobService, type JobView } from "./jobs.ts";
import { materializeSnapshot } from "./snapshot.ts";

export interface BuildServiceOptions {
  store: WorkbenchStore;
  blobs: BlobStore;
  repoRoot: string;
  hostPolicyPath: string;
  presetsDir: string;
  /** Root for per-job work dirs. */
  workRoot: string;
  workerId?: string;
  leaseMs?: number;
}

export interface BuildPlan {
  snapshotId: string;
  treeHash: string;
  target: Target;
  preset: BuildPreset;
  runner: Runner;
  caps: RunnerCapabilities;
  buildKey: string;
}

export interface BuildOutcome {
  job: JobView;
  jobResult: JobResult;
  buildResult: BuildResult | null;
}

const MISSING_DEP_CODES = new Set(["MISSING_PACKAGE", "MISSING_FONT", "MISSING_ASSET"]);

function capsSummary(caps: RunnerCapabilities): Record<string, unknown> {
  return {
    runnerId: caps.runnerId,
    engines: caps.engines,
    bibliographyModes: caps.bibliographyModes,
    isolation: caps.isolation,
    network: caps.network,
    enforces: caps.enforces,
    supportsSynctex: caps.supportsSynctex,
    supportsRecorderFls: caps.supportsRecorderFls,
  };
}

/**
 * Build clock for a snapshot: the creation time (Unix seconds) of the
 * project's EARLIEST snapshot with the same tree hash. Same content → same
 * clock, so cache hits, rebuilds and the release clean-room comparison stay
 * byte-identical, while \today in a draft shows when that content was
 * first produced instead of 1970-01-01.
 */
export function snapshotSourceDateEpoch(store: WorkbenchStore, scope: Scope, snapshotId: string): number {
  const snap = store.getSnapshot(scope, snapshotId);
  const treeHash = snap?.["tree_hash"] as string | undefined;
  const first = treeHash !== undefined ? store.earliestSnapshotWithTree(scope, treeHash) : null;
  const iso = (first?.["created_at"] ?? snap?.["created_at"]) as string | undefined;
  const ms = iso !== undefined ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
}

export class BuildService {
  private readonly opts: BuildServiceOptions;
  private readonly jobs: JobService;
  private readonly runners: Map<string, Runner>;
  private readonly cancels = new Map<string, AbortController>();
  readonly workerId: string;
  readonly leaseMs: number;

  constructor(opts: BuildServiceOptions) {
    this.opts = opts;
    this.workerId = opts.workerId ?? `worker-${process.pid}`;
    this.leaseMs = opts.leaseMs ?? 30_000;
    this.jobs = new JobService(opts.store, this.workerId);
    this.runners = createRunners({
      repoRoot: opts.repoRoot,
      hostPolicyPath: opts.hostPolicyPath,
    });
  }

  jobService(): JobService {
    return this.jobs;
  }

  runnerMap(): Map<string, Runner> {
    return this.runners;
  }

  /** Resolve snapshot, target, preset, runner and buildKey for a request. */
  resolveBuild(scope: Scope, input: {
    snapshotId?: string | null;
    targetId?: string | null;
    presetId?: string | null;
  }): BuildPlan {
    const { store, blobs } = this.opts;
    const project = store.getProject(scope);
    if (project === null) {
      throw new WorkbenchError(ERROR_CODES.NOT_FOUND, `project ${scope.projectId} not found`);
    }
    const snapshotId = input.snapshotId ?? (project["head_snapshot_id"] as string | null);
    if (snapshotId === null || snapshotId === undefined) {
      throw new WorkbenchError(ERROR_CODES.NOT_FOUND, "project has no snapshot to build");
    }
    const snapshot = store.getSnapshot(scope, snapshotId);
    if (snapshot === null) {
      throw new WorkbenchError(ERROR_CODES.NOT_FOUND, `snapshot ${snapshotId} not found`);
    }
    const treeHash = snapshot["tree_hash"] as string;

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

    const presetForEngine = (engine: "pdflatex" | "xelatex" | "lualatex"): string => {
      if (input.presetId !== undefined && input.presetId !== null) return input.presetId;
      return engine === "xelatex" ? "local-tectonic-xelatex" : `docker-texlive-${engine}`;
    };
    const target = resolveTarget(inspection, derived, {
      requestedTargetId: input.targetId ?? null,
      engineFallback: "xelatex",
      presetForEngine,
    });
    if (target === null) {
      throw new WorkbenchError(
        ERROR_CODES.TARGET_AMBIGUOUS,
        `could not resolve a single build root; candidates: ${inspection.rootCandidates.map((c) => c.path).join(", ") || "none"}`,
      );
    }
    // Persist the resolved target so later builds see it as explicit.
    const targetJson = canonicalJson(target);
    store.putTarget(scope, target.id, targetJson, digestJson(target));

    const preset = loadPreset(this.opts.presetsDir, target.buildPresetId);
    const runner = runnerForPreset(this.runners, preset);
    const caps = runner.capabilities();
    const buildKey = digestJson({
      treeHash,
      target,
      toolchainDigest: caps.toolchainDigest,
      presetId: preset.id,
      runnerCapabilities: capsSummary(caps),
      // The pinned build clock changes output bytes (\today, PDF dates), so
      // it is part of the cache identity — outputs built under an older
      // clock rule are never replayed.
      sourceDateEpoch: snapshotSourceDateEpoch(store, scope, snapshotId),
    });
    return { snapshotId, treeHash, target, preset, runner, caps, buildKey };
  }

  /**
   * Submit a build: cache dedupe (unless clean) then enqueue.
   *
   * The whole submission decision is claimed under the context idempotency
   * key — same key + same input replays the same job instead of enqueueing
   * twice, so concurrent identical submissions produce exactly one job.
   */
  submit(scope: Scope, ctx: RequestContext, input: {
    snapshotId?: string | null;
    targetId?: string | null;
    presetId?: string | null;
    clean?: boolean;
  }): { job: JobView; cacheHit: boolean } {
    requireCapability(ctx, "build.execute");
    const digest = sha256Hex(
      canonicalJson({
        kind: "build-submit",
        snapshotId: input.snapshotId ?? null,
        targetId: input.targetId ?? null,
        presetId: input.presetId ?? null,
        clean: input.clean === true,
      }),
    );
    const { result: stored } = runIdempotent(
      this.opts.store,
      ctx,
      scope.projectId,
      "build.submit",
      digest,
      () => this.submitClaimed(scope, ctx, input),
    );
    const job = this.jobs.get(scope, stored.jobId);
    if (job === null) {
      throw new WorkbenchError(
        ERROR_CODES.NOT_FOUND,
        `idempotent replay referenced missing job ${stored.jobId}`,
      );
    }
    return { job, cacheHit: stored.cacheHit };
  }

  private submitClaimed(scope: Scope, ctx: RequestContext, input: {
    snapshotId?: string | null;
    targetId?: string | null;
    presetId?: string | null;
    clean?: boolean;
  }): { jobId: string; cacheHit: boolean } {
    const plan = this.resolveBuild(scope, input);

    if (input.clean !== true) {
      const prior = this.opts.store.latestSucceededByDigest(scope, "build.run", plan.buildKey);
      if (prior !== null) {
        const priorResult = JSON.parse((prior["result_json"] as string) ?? "null") as {
          buildResult?: BuildResult;
        } | null;
        if (priorResult?.buildResult?.status === "compiled") {
          const job = this.jobs.enqueue(scope, {
            principalId: ctx.principalId,
            action: "build.run",
            inputDigest: plan.buildKey,
            inputJson: canonicalJson({
              action: "run",
              snapshotId: plan.snapshotId,
              targetId: plan.target.id,
              clean: false,
              cache: "hit",
            }),
            snapshotId: plan.snapshotId,
            targetId: plan.target.id,
          });
          return { jobId: job.jobId, cacheHit: true };
        }
      }
    }

    const job = this.jobs.enqueue(scope, {
      principalId: ctx.principalId,
      action: "build.run",
      inputDigest: plan.buildKey,
      inputJson: canonicalJson({
        action: "run",
        snapshotId: plan.snapshotId,
        targetId: plan.target.id,
        presetId: input.presetId ?? null,
        clean: input.clean === true,
      }),
      snapshotId: plan.snapshotId,
      targetId: plan.target.id,
    });
    return { jobId: job.jobId, cacheHit: false };
  }

  /**
   * Execute a queued build job end-to-end (in-process worker). Handles
   * claim, materialization, runner invocation, diagnostics, artifact
   * collection and the final state CAS — including cancel/timeout races.
   */
  async execute(scope: Scope, jobId: string): Promise<BuildOutcome> {
    const job = this.jobs.get(scope, jobId);
    if (job === null) {
      throw new WorkbenchError(ERROR_CODES.NOT_FOUND, `job ${jobId} not found`);
    }
    if (job.state !== "queued") {
      return { job, jobResult: this.toJobResult(scope, job, null, null, []), buildResult: null };
    }
    const isCacheHit = (
      JSON.parse(
        (this.opts.store.getJob(scope, jobId)?.["input_json"] as string) ?? "{}",
      ) as { cache?: string }
    ).cache === "hit";

    const fencingToken = this.jobs.claimSpecific(scope, jobId, this.leaseMs);
    if (fencingToken === null) {
      throw new WorkbenchError(
        ERROR_CODES.RUNTIME_UNAVAILABLE,
        `job ${jobId} could not be claimed`,
        { retryable: true },
      );
    }

    if (isCacheHit) {
      return this.completeCacheHit(scope, jobId, fencingToken);
    }

    const input = JSON.parse(
      (this.opts.store.getJob(scope, jobId)?.["input_json"] as string) ?? "{}",
    ) as { snapshotId?: string; targetId?: string; presetId?: string };
    const plan = this.resolveBuild(scope, {
      snapshotId: input.snapshotId ?? job.snapshotId,
      targetId: input.targetId ?? job.targetId,
      presetId: input.presetId ?? null,
    });

    const jobDir = join(this.opts.workRoot, jobId);
    const workRootDir = join(jobDir, "src");
    const outputDir = join(jobDir, "out");
    const scratchDir = join(jobDir, "scratch");
    mkdirSync(outputDir, { recursive: true });
    materializeSnapshot({
      store: this.opts.store,
      blobs: this.opts.blobs,
      scope,
      snapshotId: plan.snapshotId,
      workDir: workRootDir,
    });
    // entry-parent workingDirectory: cwd is the entry's own directory.
    const runWorkDir =
      plan.target.workingDirectory === "entry-parent"
        ? join(workRootDir, dirname(plan.target.root))
        : workRootDir;
    const entryFile =
      plan.target.workingDirectory === "entry-parent"
        ? basename(plan.target.root)
        : plan.target.root;

    const controller = new AbortController();
    this.cancels.set(jobId, controller);

    // Heartbeat + cancel watcher: a committed cancel-requested row aborts
    // the child (works for cross-process cancels, not just the registry).
    const heartbeatTimer = setInterval(() => {
      this.jobs.heartbeat(scope, jobId, fencingToken, this.leaseMs);
      const row = this.opts.store.getJob(scope, jobId);
      if (row !== null && row["state"] === "cancel-requested") {
        controller.abort();
      }
    }, Math.max(250, Math.floor(this.leaseMs / 4)));
    heartbeatTimer.unref();

    let runnerResult: RunnerResult | null = null;
    let runnerError: WorkbenchError | null = null;
    try {
      runnerResult = await plan.runner.run({
        jobId,
        workDir: runWorkDir,
        entryFile,
        engine: plan.target.engine,
        bibliographyMode: plan.target.bibliography,
        outputDir,
        scratchDir,
        preset: plan.preset,
        signal: controller.signal,
        sourceDateEpoch: snapshotSourceDateEpoch(this.opts.store, scope, plan.snapshotId),
      });
    } catch (error) {
      runnerError = error instanceof WorkbenchError
        ? error
        : new WorkbenchError(ERROR_CODES.RUNTIME_UNAVAILABLE, String(error));
    } finally {
      clearInterval(heartbeatTimer);
      this.cancels.delete(jobId);
    }

    const current = this.opts.store.getJob(scope, jobId);
    const currentState = (current?.["state"] as string) ?? "lost";

    // ---- runner-level refusal/unavailability ---------------------------
    if (runnerError !== null) {
      if (runnerError.code === ERROR_CODES.ENGINE_MISMATCH) {
        // Dependency-blocked is a build outcome, not a job failure.
        const diag: Diagnostic = {
          code: "ENGINE_MISMATCH",
          severity: "error",
          message: runnerError.message,
          source: null,
          page: null,
          causeId: null,
          evidenceArtifactIds: [],
          rawLogRange: null,
          confidence: "certain",
        };
        const artifacts: CollectedArtifact[] = [this.reportArtifact(jobId, [diag])];
        const buildResult = this.buildResultSkeleton(plan, jobId, runnerResult, [diag]);
        buildResult.status = "dependency-blocked";
        buildResult.logArtifactId = artifacts[0]?.artifactId ?? buildResult.logArtifactId;
        return this.settle(scope, jobId, fencingToken, currentState, {
          state: "succeeded",
          resultJson: canonicalJson({ buildResult }),
          buildResult,
          artifactIds: [artifacts[0]!.artifactId],
          publish: () => {
            insertArtifactRows({
              store: this.opts.store,
              scope,
              snapshotId: plan.snapshotId,
              targetId: plan.target.id,
              jobId,
              artifacts,
            });
          },
        });
      }
      return this.settle(scope, jobId, fencingToken, currentState, {
        state: "failed",
        errorCode: runnerError.code,
        buildResult: null,
        artifactIds: [],
      });
    }

    const rr = runnerResult as RunnerResult;

    // ---- killed paths ---------------------------------------------------
    if (rr.timedOut || rr.killedBy === "timeout") {
      return this.settle(scope, jobId, fencingToken, currentState, {
        state: "timed-out",
        errorCode: "BUILD_TIMEOUT",
        buildResult: null,
        artifactIds: [],
      });
    }
    if (rr.killedBy === "cancel" || currentState === "cancel-requested") {
      return this.settle(scope, jobId, fencingToken, currentState, {
        state: "cancelled",
        errorCode: "CANCELLED",
        buildResult: null,
        artifactIds: [],
      });
    }
    if (rr.outputTruncated) {
      return this.settle(scope, jobId, fencingToken, currentState, {
        state: "failed",
        errorCode: "RESOURCE_LIMIT",
        buildResult: null,
        artifactIds: [],
      });
    }

    // ---- normal exit: parse logs, collect artifacts --------------------
    const entryBase = basename(plan.target.root).replace(/\.[^.]+$/, "");
    const logName = `${entryBase}.log`;
    const logPath = join(outputDir, logName);
    let diagnostics: Diagnostic[] = [];
    if (existsSync(logPath)) {
      const parsed = parseTexLog(readFileSync(logPath, "utf8"), plan.target.root, {
        // The same rows materializeSnapshot wrote into the job workdir.
        projectPaths: this.opts.store
          .listSnapshotFiles(scope, plan.snapshotId)
          .filter((r) => r["role"] === "source" || r["role"] === "provided-bbl")
          .map((r) => r["path"] as string),
        // Log paths are relative to the engine cwd (entry-parent: entry dir).
        baseDir: plan.target.workingDirectory === "entry-parent" ? dirname(plan.target.root) : "",
        workDir: runWorkDir,
      });
      diagnostics = parsed.diagnostics;
      if (parsed.pageCount !== null) {
        // BuildResult has no page field; an info diagnostic carries it so an
        // agent need not dig through the log to report the page count.
        diagnostics.push({
          code: "OUTPUT_PAGES",
          severity: "info",
          message: `output has ${parsed.pageCount} page${parsed.pageCount === 1 ? "" : "s"}`,
          source: null,
          page: null,
          causeId: null,
          evidenceArtifactIds: [],
          rawLogRange: null,
          confidence: "certain",
        });
      }
      if (parsed.noOutputWritten && diagnostics.length === 0) {
        diagnostics.push({
          code: "TEX_ERROR",
          severity: "error",
          message: "engine produced no pages of output and no parseable error",
          source: null,
          page: null,
          causeId: null,
          evidenceArtifactIds: [],
          rawLogRange: null,
          confidence: "unknown",
        });
      }
    } else {
      const stderrText = existsSync(rr.stderrPath) ? readFileSync(rr.stderrPath, "utf8") : "";
      diagnostics = parseRunnerStderr(stderrText);
      if (diagnostics.length === 0) {
        diagnostics.push({
          code: "TEX_ERROR",
          severity: "error",
          message: "no .log artifact produced; stderr contained no parseable error",
          source: null,
          page: null,
          causeId: null,
          evidenceArtifactIds: [],
          rawLogRange: null,
          confidence: "unknown",
        });
      }
    }

    const collected = collectArtifacts({
      blobs: this.opts.blobs,
      outputDir,
      maxOutputBytes: plan.preset.limits.maxOutputBytes,
      jobId,
    });
    // Runner stdout/stderr are persisted evidence artifacts too.
    for (const path of [rr.stdoutPath, rr.stderrPath]) {
      if (existsSync(path)) {
        const bytes = readFileSync(path);
        const blob = this.opts.blobs.put(bytes);
        collected.artifacts.push({
          artifactId: `log-${blob.hash.slice(0, 16)}`,
          relPath: basename(path),
          kind: "log",
          blobHash: blob.hash,
          sizeBytes: bytes.length,
          mediaType: "text/plain",
        });
      }
    }
    // A succeeded job must reference a real log artifact; if the engine
    // produced none, persist a build report so the id is never a placeholder.
    if (!collected.artifacts.some((a) => a.kind === "log")) {
      collected.artifacts.push(this.reportArtifact(jobId, diagnostics));
    }

    const buildResult = this.buildResultSkeleton(plan, jobId, rr, diagnostics);
    buildResult.logArtifactId =
      collected.artifacts.find((a) => a.relPath === logName)?.artifactId ??
      collected.artifacts.find((a) => a.kind === "log")?.artifactId ??
      buildResult.logArtifactId;
    buildResult.dependencyManifestId = collected.depManifestArtifact?.artifactId ?? null;

    // ---- read-boundary audit (SEC-04) -----------------------------------
    // deps.mk/.fls is the engine's own ledger of every file it opened.
    // --untrusted does NOT stop absolute-path \input (verified: tectonic
    // 0.17 opened /etc/passwd) — so a source that escaped the job dirs is
    // caught here, and its pdf is quarantined rather than published.
    const readRoots = plan.runner.dependencyReadRoots === undefined
      ? [] // runner declares no extra roots: job dirs only (strictest)
      : plan.runner.dependencyReadRoots({
          jobId,
          workDir: runWorkDir,
          entryFile,
          engine: plan.target.engine,
          bibliographyMode: plan.target.bibliography,
          outputDir,
          scratchDir,
          preset: plan.preset,
        });
    // null = boundary enforced by container isolation, audit not applicable.
    const quarantineReasons: string[] = [];
    if (readRoots !== null) {
      const allowed = [resolve(jobDir), ...readRoots.map((r) => resolve(r))];
      const inAllowed = (p: string): boolean =>
        allowed.some((root) => p === root || p.startsWith(root + sep));
      const escaped: string[] = [];
      for (const dep of collected.dependencies ?? []) {
        const abs = isAbsolute(dep) ? resolve(dep) : resolve(runWorkDir, dep);
        if (!inAllowed(abs)) escaped.push(dep);
      }
      if (escaped.length > 0) {
        quarantineReasons.push(
          `build read ${escaped.length} path(s) outside the allowed roots: ${escaped.slice(0, 5).join(", ")}`,
        );
      }
      // A pdf with no dependency ledger cannot prove its reads stayed in
      // bounds — fail closed rather than publish unverifiable output.
      if (collected.pdf !== null && collected.dependencies === null) {
        quarantineReasons.push("no dependency manifest produced — pdf reads cannot be verified");
      }
    }
    if (quarantineReasons.length > 0) {
      diagnostics.push({
        code: "SECURITY_BOUNDARY",
        severity: "error",
        message: quarantineReasons.join("; "),
        source: null,
        page: null,
        causeId: null,
        evidenceArtifactIds: collected.depManifestArtifact !== null
          ? [collected.depManifestArtifact.artifactId]
          : [],
        rawLogRange: null,
        confidence: "certain",
      });
      // Quarantine: the pdf blob stays in CAS as evidence but no artifact
      // row is published, so downstream checks/releases never see it.
      if (collected.pdf !== null) {
        collected.artifacts = collected.artifacts.filter((a) => a !== collected.pdf);
        collected.pdf = null;
      }
    }

    // ---- status decision ------------------------------------------------
    const hasMissingDep = diagnostics.some(
      (d) => d.severity === "error" && MISSING_DEP_CODES.has(d.code),
    );
    const hasOtherError = diagnostics.some(
      (d) => d.severity === "error" && !MISSING_DEP_CODES.has(d.code),
    );
    if (quarantineReasons.length > 0) {
      // Boundary escape or missing ledger: never "compiled", even if the
      // engine exited 0 and produced a valid pdf.
      buildResult.status = "compile-failed";
    } else if (rr.exitCode === 0 && collected.pdf !== null) {
      buildResult.status = "compiled";
      buildResult.pdfArtifactId = collected.pdf.artifactId;
    } else if (hasMissingDep && !hasOtherError) {
      buildResult.status = "dependency-blocked";
    } else if (rr.exitCode === 0 && collected.pdf === null) {
      buildResult.status = "invalid-artifact";
      diagnostics.push({
        code: "INVALID_ARTIFACT",
        severity: "error",
        message: `pdf artifact failed validation: ${collected.pdfValidation?.detail ?? "no pdf produced"}`,
        source: null,
        page: null,
        causeId: null,
        evidenceArtifactIds: [],
        rawLogRange: null,
        confidence: "certain",
      });
    } else {
      buildResult.status = "compile-failed";
    }
    buildResult.diagnostics = diagnostics;

    const createdAt = utcNowIso();
    const publish = (): void => {
      insertArtifactRows({
        store: this.opts.store,
        scope,
        snapshotId: plan.snapshotId,
        targetId: plan.target.id,
        jobId,
        artifacts: collected.artifacts,
        createdAt,
      });
      for (const a of collected.artifacts) {
        this.opts.store.emitProjectEventInTx(scope, {
          jobId,
          createdAt,
          eventJson: (seq) =>
            canonicalJson({
              schemaVersion: 1,
              seq,
              projectId: scope.projectId,
              jobId,
              snapshotId: plan.snapshotId,
              attempt: job.attempt,
              fencingToken,
              type: "artifact.created",
              timestamp: createdAt,
              payload: artifactRefOf(scope, plan.snapshotId, plan.target.id, jobId, a, createdAt),
            }),
        });
      }
      for (const d of diagnostics) {
        this.opts.store.emitProjectEventInTx(scope, {
          jobId,
          createdAt,
          eventJson: (seq) =>
            canonicalJson({
              schemaVersion: 1,
              seq,
              projectId: scope.projectId,
              jobId,
              snapshotId: plan.snapshotId,
              attempt: job.attempt,
              fencingToken,
              type: "job.diagnostic",
              timestamp: createdAt,
              payload: d,
            }),
        });
      }
    };

    return this.settle(scope, jobId, fencingToken, currentState, {
      state: "succeeded",
      resultJson: canonicalJson({ buildResult }),
      buildResult,
      artifactIds: collected.artifacts.map((a) => a.artifactId),
      publish,
    });
  }

  /** A real artifact row for a synthesized build report (never fake ids). */
  private reportArtifact(jobId: string, diagnostics: Diagnostic[]): CollectedArtifact {
    const text = canonicalJson({ jobId, diagnostics, generatedAt: utcNowIso() });
    const blob = this.opts.blobs.put(new TextEncoder().encode(text));
    return {
      artifactId: `log-${blob.hash.slice(0, 16)}`,
      relPath: "build-report.json",
      kind: "log",
      blobHash: blob.hash,
      sizeBytes: text.length,
      mediaType: "application/json",
    };
  }

  private buildResultSkeleton(
    plan: BuildPlan,
    jobId: string,
    rr: RunnerResult | null,
    diagnostics: Diagnostic[],
  ): BuildResult {
    return {
      kind: "build-result",
      jobId,
      snapshotId: plan.snapshotId,
      targetId: plan.target.id,
      toolchainDigest: plan.caps.toolchainDigest,
      status: "compile-failed",
      exitCode: rr?.exitCode ?? null,
      durationMs: rr?.durationMs ?? 0,
      cacheHit: false,
      reusedFromJobId: null,
      pdfArtifactId: null,
      logArtifactId: "",
      dependencyManifestId: null,
      diagnostics,
    };
  }

  private completeCacheHit(
    scope: Scope,
    jobId: string,
    fencingToken: number,
  ): BuildOutcome {
    // Find the ORIGINAL succeeded job for this buildKey — excluding the
    // fresh access record we just claimed (same digest!).
    const job = this.jobs.get(scope, jobId);
    const digest = this.opts.store.getJob(scope, jobId)?.["input_digest"] as string;
    const prior = this.opts.store
      .listJobs(scope, { limit: 500 })
      .filter(
        (r) =>
          r["job_id"] !== jobId &&
          r["input_digest"] === digest &&
          r["state"] === "succeeded" &&
          (JSON.parse((r["result_json"] as string) ?? "null") as { buildResult?: BuildResult })
            ?.buildResult?.status === "compiled",
      )
      .sort((a, b) => String(b["finished_at"]).localeCompare(String(a["finished_at"])))[0];
    if (prior === undefined || job === null) {
      // The "hit" marker pointed at nothing compilable: run it fresh? The
      // honest answer is failure — the cache entry must have existed.
      this.jobs.finalize(scope, jobId, fencingToken, {
        state: "failed",
        errorCode: "CACHE_MISS",
      });
      throw new WorkbenchError(
        ERROR_CODES.NOT_FOUND,
        `cache-hit job ${jobId} found no prior compiled build for digest`,
      );
    }
    const priorResult = JSON.parse((prior["result_json"] as string) ?? "null") as {
      buildResult?: BuildResult;
    };
    const reused: BuildResult = {
      ...(priorResult.buildResult as BuildResult),
      jobId,
      cacheHit: true,
      reusedFromJobId: prior["job_id"] as string,
    };
    const ok = this.jobs.finalize(scope, jobId, fencingToken, {
      state: "succeeded",
      resultJson: canonicalJson({ buildResult: reused }),
    });
    if (!ok) {
      throw new WorkbenchError(
        ERROR_CODES.RUNTIME_UNAVAILABLE,
        `cache-hit job ${jobId} lost its claim before finalize`,
        { retryable: true },
      );
    }
    const view = this.jobs.get(scope, jobId) as JobView;
    // The reused artifacts belong to the prior job — this job created no
    // artifact rows, so publish the real reused set (the prior job's rows),
    // not [] and not only the ids BuildResult happens to name.
    const reusedArtifactIds = this.opts.store
      .listArtifactsByJob(scope, prior["job_id"] as string)
      .map((a) => a["artifact_id"] as string);
    return {
      job: view,
      jobResult: this.toJobResult(scope, view, reused, null, reusedArtifactIds),
      buildResult: reused,
    };
  }

  /**
   * Terminal settlement: the fencing CAS decides whether THIS worker still
   * owns the job. publish() runs inside the finalize transaction, so a lost
   * race publishes nothing. If cancel-requested won the race first, a
   * 'succeeded' outcome is converted to 'cancelled' WITHOUT publishing.
   */
  private settle(
    scope: Scope,
    jobId: string,
    fencingToken: number,
    currentState: string,
    outcome: {
      state: "succeeded" | "failed" | "cancelled" | "timed-out";
      resultJson?: string;
      errorCode?: string;
      buildResult: BuildResult | null;
      artifactIds: string[];
      publish?: () => void;
    },
  ): BuildOutcome {
    let state = outcome.state;
    if (currentState === "cancel-requested" && state === "succeeded") {
      state = "cancelled";
    }
    let ok = this.jobs.finalize(
      scope,
      jobId,
      fencingToken,
      { state, resultJson: outcome.resultJson ?? null, errorCode: outcome.errorCode ?? null },
      state === "succeeded" ? outcome.publish : undefined,
    );
    if (!ok && state === "succeeded") {
      // Race resolution: a cancel-requested committed between our read and
      // the finalize CAS — yield to it WITHOUT publishing artifacts.
      const row = this.opts.store.getJob(scope, jobId);
      if (row !== null && row["state"] === "cancel-requested") {
        ok = this.jobs.finalize(scope, jobId, fencingToken, {
          state: "cancelled",
          errorCode: "CANCELLED",
        });
        if (ok) state = "cancelled";
      }
    }
    if (!ok) {
      const view = this.jobs.get(scope, jobId);
      throw new WorkbenchError(
        ERROR_CODES.STALE_BASE,
        `job ${jobId} finalize rejected: fencing token stale or job already ${view?.state ?? "gone"}`,
      );
    }
    // Successful jobs must not leave materialized source/scratch on disk:
    // the artifacts live in the blob CAS; the working tree is pruned here.
    // Failed/cancelled jobs keep their directory for post-mortem debugging.
    if (state === "succeeded") {
      try {
        rmSync(join(this.opts.workRoot, jobId), { recursive: true, force: true });
      } catch {
        /* best-effort hygiene; the job is already committed */
      }
    }
    const view = this.jobs.get(scope, jobId) as JobView;
    return {
      job: view,
      jobResult: this.toJobResult(
        scope,
        view,
        state === "succeeded" ? outcome.buildResult : null,
        outcome.errorCode ?? null,
        state === "succeeded" ? outcome.artifactIds : [],
      ),
      buildResult: state === "succeeded" ? outcome.buildResult : null,
    };
  }

  private toJobResult(
    scope: Scope,
    view: JobView,
    buildResult: BuildResult | null,
    errorCode: string | null,
    artifactIds: string[],
  ): JobResult {
    return {
      kind: "job-status",
      jobId: view.jobId,
      state: view.state,
      snapshotId: view.snapshotId,
      attempt: view.attempt,
      resultArtifactIds:
        artifactIds.length > 0
          ? artifactIds
          : this.opts.store
              .listArtifactsByJob(scope, view.jobId)
              .map((a) => a["artifact_id"] as string),
      error:
        errorCode !== null
          ? { code: errorCode, message: `job ${view.jobId} ended ${view.state}`, retryable: view.state === "lost" }
          : null,
      buildResult,
    };
  }

  /** Submit + execute in one call (CLI path). */
  async build(scope: Scope, ctx: RequestContext, input: {
    snapshotId?: string | null;
    targetId?: string | null;
    presetId?: string | null;
    clean?: boolean;
  }): Promise<BuildOutcome> {
    const { job } = this.submit(scope, ctx, input);
    return this.execute(scope, job.jobId);
  }

  /**
   * Cancel a job: durable state transition plus in-process abort when the
   * executing worker lives in this process.
   */
  cancel(scope: Scope, jobId: string): string {
    const outcome = this.jobs.requestCancel(scope, jobId);
    if (outcome === "cancel-requested") {
      this.cancels.get(jobId)?.abort();
    }
    return outcome;
  }

  sweepExpiredLeases(scope: Scope): string[] {
    return this.jobs.sweepExpiredLeases(scope);
  }

  retryLost(scope: Scope, jobId: string): JobView {
    return this.jobs.retryLost(scope, jobId);
  }
}
