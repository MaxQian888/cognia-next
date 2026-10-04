#!/usr/bin/env node
/**
 * latexwb CLI — real end-to-end entry (no pi dependency). All commands emit
 * schema-shaped JSON on stdout; `artifact cat` streams raw blob bytes.
 * Errors emit a JSON ToolError on stderr with exit 3.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAPABILITIES,
  createRequestContext,
  importFromDirectory,
  inspectDerived,
  BuildService,
  JobService,
  proposePatch,
  applyPatch,
  proposeRevert,
  grantApproval,
  revokeApproval,
  materializeToHost,
  recoverMaterialization,
  startWorkflow,
  resumeWorkflow,
  cancelWorkflow,
  getWorkflowStatus,
  listWorkflows,
  inspectSourceAsset,
  type WorkflowContext,
  type WorkflowDeps,
} from "@latexwb/core";
import {
  openDatabase,
  migrate,
  WorkbenchStore,
  BlobStore,
} from "@latexwb/storage";
import {
  NotImplementedError,
  WorkbenchError,
  ERROR_CODES,
  validatorFor,
  type FileOperation,
  type HostPolicy,
  type Target,
} from "@latexwb/contracts";
import { provisionToolchain, provisionRenderer } from "@latexwb/runtime";
import {
  runReleaseChecks,
  runDataAssetChecks,
  runDraftChecks,
  readCheckReport,
  renderPages,
  renderText,
  submitPageReview,
  pageReviewCoverage,
  prepareRelease,
  freezeRelease,
  packageRelease,
  releaseApprovalDigest,
  type ReleaseProfileId,
} from "@latexwb/core";
import { runDoctor } from "./doctor.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

const UNIMPLEMENTED: ReadonlySet<string> = new Set(["serve", "edit"]);

/**
 * Flat command aliases.  The original CLI exposed several operations as
 * second-level positionals (for example `release prepare`).  Keep those
 * spellings for compatibility, but make every operation directly invocable
 * so shell completion, policy checks, and automation do not need to special
 * case a command tree.
 */
const FLAT_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  "render-pages": ["render", "pages"],
  "render-text": ["render", "text"],
  "check-run": ["check", "run"],
  "check-report": ["check", "report"],
  "review-page": ["review"],
  "review-coverage": ["review", "coverage"],
  "release-prepare": ["release", "prepare"],
  "release-freeze": ["release", "freeze"],
  "release-package": ["release", "package"],
  "release-list": ["release", "list"],
  "release-status": ["release", "status"],
  "artifact-cat": ["artifact", "cat"],
  "artifact-save": ["artifact", "save"],
  "patch-propose": ["patch", "propose"],
  "patch-apply": ["patch", "apply"],
  "patch-show": ["patch", "show"],
  "patch-revert": ["patch", "revert"],
  "approvals-list": ["approvals", "list"],
  "approvals-revoke": ["approvals", "revoke"],
  "assets-inspect": ["assets", "inspect"],
  "workflow-start": ["workflow", "start"],
  "workflow-status": ["workflow", "status"],
  "workflow-cancel": ["workflow", "cancel"],
  "workflow-resume": ["workflow", "resume"],
  "workflow-list": ["workflow", "list"],
};

interface CliEnv {
  stateDir: string;
  store: WorkbenchStore;
  blobs: BlobStore;
  workspaceId: string;
}

/**
 * Closed flag set — same contract as the schema layer's
 * `additionalProperties: false`: an unknown flag or stray positional arg is
 * a usage error, never silently ignored.
 */
const KNOWN_FLAGS: ReadonlySet<string> = new Set([
  "state",
  "workspace",
  "principal",
  "session",
  "idempotency-key",
  "project",
  "snapshot",
  "target",
  "preset",
  "clean",
  "watch",
  "after",
  "patch",
  "action",
  "reason",
  "expires-in-seconds",
  "ops",
  "dir",
  "takeover",
  "context",
  "input",
  // M4
  "artifact",
  "verdict",
  "note",
  "digest",
  "profile",
  "baseline",
  "ruleset",
  "release",
  "pages",
  "report",
]);

function parseArgs(argv: string[]): { positional: string[]; flags: Map<string, string | boolean> } {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else if (i + 1 < argv.length && !(argv[i + 1] as string).startsWith("--")) {
        flags.set(arg.slice(2), argv[i + 1] as string);
        i += 1;
      } else {
        flags.set(arg.slice(2), true);
      }
    } else {
      positional.push(arg);
    }
  }
  for (const name of flags.keys()) {
    if (!KNOWN_FLAGS.has(name)) {
      process.stderr.write(`${JSON.stringify({ error: { code: "INVALID_REQUEST", message: `unknown flag --${name}`, retryable: false } })}\n`);
      process.exit(1);
    }
  }
  return { positional, flags };
}

function expectPositional(positional: string[], min: number, max: number): void {
  if (positional.length < min || positional.length > max) usage();
}

function flagString(flags: Map<string, string | boolean>, name: string): string | null {
  const v = flags.get(name);
  return typeof v === "string" ? v : null;
}

function openEnv(flags: Map<string, string | boolean>): CliEnv {
  const stateDir = resolve(flagString(flags, "state") ?? "./.latexwb");
  mkdirSync(join(stateDir, "blobs"), { recursive: true });
  mkdirSync(join(stateDir, "jobs"), { recursive: true });
  const db = openDatabase(join(stateDir, "workbench.db"));
  migrate(db, join(repoRoot, "migrations"));
  return {
    stateDir,
    store: new WorkbenchStore(db),
    blobs: new BlobStore(stateDir),
    workspaceId: flagString(flags, "workspace") ?? "local",
  };
}

/**
 * Host operator identity: --principal flag, then the LATEXWB_PRINCIPAL
 * environment variable, then the local default. This is the LOCAL host-auth
 * boundary — the operator is whoever controls the CLI invocation (documented
 * in docs/UNSUPPORTED.md); it is never read from file content or tool params.
 */
function hostPrincipal(flags: Map<string, string | boolean>): string {
  return flagString(flags, "principal") ?? process.env["LATEXWB_PRINCIPAL"] ?? "cli-operator";
}

function cliCtx(env: CliEnv, flags: Map<string, string | boolean>) {
  return createRequestContext({
    workspaceId: env.workspaceId,
    principalId: hostPrincipal(flags),
    sessionId: flagString(flags, "session") ?? "cli-session",
    idempotencyKey: flagString(flags, "idempotency-key") ?? undefined,
    policyId: "default",
    grantedCapabilities: CAPABILITIES,
  });
}

function buildService(env: CliEnv): BuildService {
  return new BuildService({
    store: env.store,
    blobs: env.blobs,
    repoRoot,
    hostPolicyPath: join(repoRoot, "runtime/host-policy.json"),
    presetsDir: join(repoRoot, "runtime/presets"),
    workRoot: join(env.stateDir, "jobs"),
  });
}

function hostPolicy(): HostPolicy | null {
  try {
    return JSON.parse(
      readFileSync(join(repoRoot, "runtime/host-policy.json"), "utf8"),
    ) as HostPolicy;
  } catch {
    return null;
  }
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Read a patch-operations file from a HOST path (the file is operator-
 * supplied, not model output — but it is still validated as untrusted JSON
 * against the FileOperation schema before it reaches proposePatch).
 * Shape: { "reason": string, "operations": [FileOperation...],
 *          "citekeyMapping"?: { old: new } }
 */
function readOpsFile(path: string): {
  reason: string;
  operations: FileOperation[];
  citekeyMapping?: Record<string, string> | undefined;
} {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch (error) {
    throw new WorkbenchError(ERROR_CODES.INVALID_REQUEST, `cannot read ops file ${path}: ${String(error)}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new WorkbenchError(ERROR_CODES.INVALID_REQUEST, "ops file must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj["reason"] !== "string" || obj["reason"].length === 0) {
    throw new WorkbenchError(ERROR_CODES.INVALID_REQUEST, "ops file requires a non-empty 'reason' string");
  }
  if (!Array.isArray(obj["operations"]) || obj["operations"].length === 0) {
    throw new WorkbenchError(ERROR_CODES.INVALID_REQUEST, "ops file requires a non-empty 'operations' array");
  }
  const validateOp = validatorFor("FileOperation");
  const operations: FileOperation[] = [];
  for (const [i, op] of (obj["operations"] as unknown[]).entries()) {
    if (!validateOp(op)) {
      throw new WorkbenchError(
        ERROR_CODES.SCHEMA_VALIDATION_FAILED,
        `ops file operation[${i}] failed schema validation: ${JSON.stringify(validateOp.errors)}`,
      );
    }
    operations.push(op as FileOperation);
  }
  const mapping = obj["citekeyMapping"];
  if (mapping !== undefined) {
    if (
      typeof mapping !== "object" ||
      mapping === null ||
      Object.entries(mapping).some(([k, v]) => typeof k !== "string" || typeof v !== "string")
    ) {
      throw new WorkbenchError(ERROR_CODES.INVALID_REQUEST, "ops file 'citekeyMapping' must be a string→string object");
    }
  }
  return {
    reason: obj["reason"],
    operations,
    citekeyMapping: mapping as Record<string, string> | undefined,
  };
}

function readJsonFile(path: string): unknown {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch (error) {
    throw new WorkbenchError(ERROR_CODES.INVALID_REQUEST, `cannot read JSON file ${path}: ${String(error)}`);
  }
  return raw;
}

const WORKFLOW_CONTEXT_KEYS: ReadonlySet<string> = new Set([
  "snapshotId", "targetId", "pdfArtifactId", "patchId", "causeId", "baselineArtifactId",
  // M3 string-valued fields; array/object context (bibPaths, assetSpec,
  // noChange…) is not expressible through this file format by design.
  "templateId", "initTargetId", "bibReportArtifactId", "auditReportArtifactId",
  "generatedArtifactId", "checkReportArtifactId",
  // M4
  "releaseId", "releaseProfileId",
]);

/** A workflow context file is host-provided JSON — validated as untrusted
 * input (object, declared fields only, string|null values). */
function readWorkflowContext(path: string): Partial<WorkflowContext> {
  const raw = readJsonFile(path);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new WorkbenchError(ERROR_CODES.INVALID_REQUEST, "workflow context file must be a JSON object");
  }
  const out: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!WORKFLOW_CONTEXT_KEYS.has(key)) {
      throw new WorkbenchError(
        ERROR_CODES.INVALID_REQUEST,
        `workflow context file: unknown field ${JSON.stringify(key)} (allowed: ${[...WORKFLOW_CONTEXT_KEYS].join(", ")})`,
      );
    }
    if (value !== null && typeof value !== "string") {
      throw new WorkbenchError(
        ERROR_CODES.INVALID_REQUEST,
        `workflow context field ${key} must be a string or null`,
      );
    }
    out[key] = value;
  }
  return out as Partial<WorkflowContext>;
}

function fail(error: unknown): never {
  const e = error as WorkbenchError;
  const payload =
    e instanceof WorkbenchError
      ? { code: e.code, message: e.message, retryable: e.retryable }
      : { code: "INTERNAL", message: String(error), retryable: false };
  process.stderr.write(`${JSON.stringify({ error: payload })}\n`);
  process.exit(3);
}

function usage(): never {
  process.stderr.write(
    [
      "usage: latexwb <command> [flags]",
      "",
      "Flat operation commands (preferred; nested spellings remain compatible):",
      "  render-pages | render-text       render PDF pages or extracted text",
      "  check-run | check-report         run/read a check report",
      "  review-page | review-coverage    record/review page coverage",
      "  release-prepare|freeze|package|list|status",
      "  artifact-cat | artifact-save     read or save an artifact",
      "  patch-propose|apply|show|revert",
      "  approvals-list | approvals-revoke",
      "  assets-inspect",
      "  workflow-start|status|cancel|resume|list",
      "",
      "  doctor                        probe environment + runner capabilities",
      "  provision-toolchain           download+extract tectonic bundle, write toolchain lock",
      "  provision-renderer            compile the Swift/PDFKit render helper (host-only)",
      "  render pages|text --project <id> --artifact <pdfId> [--pages 1,3] [--preset screen|detail]",
      "  check run --project <id> --artifact <pdfId> [--ruleset release|draft|data-assets] [--baseline <pdfId>] [--profile]",
      "  check report --project <id> --report <reportArtifactId>",
      "  review --project <id> --artifact <pageImageId> --verdict approved|flagged [--note <text>]",
      "  review coverage --project <id> --artifact <pdfId>",
      "  release prepare --project <id> --snapshot <id> --target <id> [--profile draft|review|submission]",
      "  release freeze --project <id> --snapshot <id> --target <id> [--profile]",
      "  release package --project <id> --release <id> --artifact <pdfId> [--baseline <pdfId>]",
      "  release list|status --project <id> [<releaseId>]",
      "  export prepare|package ...    aliases of release prepare / release freeze+package",
      "  import <hostPath> [--project] import a directory into a project snapshot",
      "  inspect --project <id>        analyze head snapshot → ProjectInspection",
      "  build --project <id> [--target] [--preset] [--clean]",
      "  jobs --project <id> [--watch]",
      "  cancel <jobId> --project <id>",
      "  artifact cat <id> --project <id>     raw bytes to stdout",
      "  artifact save <id> <dest> --project <id>",
      "  events --project <id> --after <seq>",
      "  patch propose --project <id> --ops <file.json> [--snapshot <base>]",
      "  patch apply|show --project <id> --patch <id>",
      "  patch revert --project <id> --patch <id> [--reason <text>]",
      "  approve --patch <id> --project <id>   host-side grant for a patch (action=patch.apply)",
      "    [--action <a>] [--expires-in-seconds <n>]  principal = --principal or $LATEXWB_PRINCIPAL",
      "  approve --action <a> --digest <sha256> --snapshot <id> --project <id>",
      "                                 action-bound grant, e.g. release.package + approvalDigest",
      "  approvals list --project <id>",
      "  approvals revoke <approvalId> --project <id>",
      "  materialize --project <id> --dir <path> [--snapshot <id>] [--takeover]",
      "  materialize recover --project <id> --dir <path>",
      "  assets inspect <sourceAssetId> --project <id> [--snapshot <id>]",
      "                                 CSV/TSV column analysis → inspection artifact + evidence",
      "  workflow start <definitionId> --project <id> [--context <file.json>]",
      "  workflow status|cancel <workflowId> [--project <id>]",
      "  workflow resume <workflowId> --input <file.json> [--project <id>]",
      "  workflow list --project <id>",
      "flags: --state <dir> (default ./.latexwb) --workspace --principal --session --idempotency-key",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

async function main(argv: string[]): Promise<void> {
  const [rawCommand, ...rawRest] = argv;
  if (rawCommand === undefined || rawCommand === "help" || rawCommand === "--help") {
    usage();
  }
  // Expand flat operation names before parsing arguments.  This preserves the
  // existing implementation and compatibility while making the public
  // command surface first-class (e.g. `latexwb release-package`).
  const expansion = FLAT_COMMANDS[rawCommand];
  const command = expansion?.[0] ?? rawCommand;
  const rest = expansion === undefined
    ? rawRest
    : [...expansion.slice(1), ...rawRest];
  const { positional, flags } = parseArgs(rest);

  if (command === "doctor") {
    const { report, exitCode } = await runDoctor();
    printJson(report);
    process.exit(exitCode);
  }

  if (command === "provision-toolchain") {
    try {
      const result = await provisionToolchain(repoRoot);
      printJson({
        status: "resolved",
        bundleDir: result.bundleDir,
        bundleBytes: result.bundleBytes,
        manifestEntries: result.manifestEntries,
        sampledVerified: result.sampledVerified,
        smokeOk: result.smokeOk,
        toolchainDigest: result.lock.toolchainDigest,
        tectonicSha256: result.tectonicSha256,
      });
      process.exit(result.smokeOk ? 0 : 3);
    } catch (error) {
      fail(error);
    }
  }

  if (command === "provision-renderer") {
    try {
      const loaded = provisionRenderer(repoRoot);
      printJson({
        status: "provisioned",
        manifestPath: loaded.manifestPath,
        manifestSha256: loaded.manifestSha256,
        helper: loaded.manifest.helper,
        helperSha256: loaded.manifest.helperSha256,
        version: loaded.manifest.version,
        swiftcVersion: loaded.manifest.swiftcVersion,
        platform: loaded.manifest.platform,
      });
      process.exit(0);
    } catch (error) {
      fail(error);
    }
  }

  try {
    const env = openEnv(flags);
    const ctx = cliCtx(env, flags);
    const projectId = flagString(flags, "project");

    switch (command) {
      case "import": {
        expectPositional(positional, 1, 1);
        const hostPath = positional[0] as string;
        const report = importFromDirectory({
          store: env.store,
          blobs: env.blobs,
          ctx,
          hostPath: resolve(hostPath),
          projectId: projectId ?? undefined,
          hostPolicy: hostPolicy(),
        });
        printJson(report);
        break;
      }
      case "inspect": {
        expectPositional(positional, 0, 0);
        if (projectId === null) usage();
        const scope = { workspaceId: env.workspaceId, projectId };
        const project = env.store.getProject(scope);
        if (project === null) fail(new WorkbenchError(ERROR_CODES.NOT_FOUND, `project ${projectId} not found`));
        const snapshotId = flagString(flags, "snapshot") ?? (project["head_snapshot_id"] as string | null);
        if (snapshotId === null) fail(new WorkbenchError(ERROR_CODES.NOT_FOUND, "project has no snapshot"));
        const { inspection, derived } = inspectDerived({
          store: env.store,
          blobs: env.blobs,
          scope,
          snapshotId,
          projectId,
          existingTargets: env.store
            .listTargets(scope)
            .map((r) => JSON.parse(r["config_json"] as string) as Target),
        });
        printJson({ inspection, derived });
        break;
      }
      case "build": {
        expectPositional(positional, 0, 0);
        if (projectId === null) usage();
        const scope = { workspaceId: env.workspaceId, projectId };
        const outcome = await buildService(env).build(scope, ctx, {
          snapshotId: flagString(flags, "snapshot"),
          targetId: flagString(flags, "target"),
          presetId: flagString(flags, "preset"),
          clean: flags.get("clean") === true,
        });
        printJson(outcome.jobResult);
        process.exit(outcome.job.state === "succeeded" ? 0 : 4);
        break;
      }
      case "jobs": {
        expectPositional(positional, 0, 0);
        if (projectId === null) usage();
        const scope = { workspaceId: env.workspaceId, projectId };
        const svc = new JobService(env.store, `cli-${process.pid}`);
        const print = (): boolean => {
          const jobs = svc.list(scope, 100).map((j) => ({
            ...j,
            resultArtifactIds: env.store
              .listArtifactsByJob(scope, j.jobId)
              .map((a) => a["artifact_id"] as string),
          }));
          printJson(jobs);
          return jobs.every((j) =>
            ["succeeded", "failed", "cancelled", "timed-out", "lost"].includes(j.state),
          );
        };
        if (flags.get("watch") === true) {
          while (!print()) {
            await new Promise((r) => setTimeout(r, 1000));
          }
        } else {
          print();
        }
        break;
      }
      case "cancel": {
        expectPositional(positional, 1, 1);
        const jobId = positional[0] as string;
        if (projectId === null) usage();
        const scope = { workspaceId: env.workspaceId, projectId };
        const outcome = buildService(env).cancel(scope, jobId);
        printJson({ jobId, outcome });
        break;
      }
      case "artifact": {
        const sub = positional[0];
        const artifactId = positional[1];
        if (sub === "save") expectPositional(positional, 3, 3);
        else expectPositional(positional, 2, 2);
        if (sub === undefined || artifactId === undefined || projectId === null) usage();
        const scope = { workspaceId: env.workspaceId, projectId };
        const row = env.store.getArtifact(scope, artifactId);
        if (row === null) fail(new WorkbenchError(ERROR_CODES.NOT_FOUND, `artifact ${artifactId} not found`));
        const bytes = env.blobs.getVerified(row["blob_hash"] as string);
        if (sub === "cat") {
          process.stdout.write(bytes);
        } else if (sub === "save") {
          const dest = positional[2];
          if (dest === undefined) usage();
          writeFileSync(resolve(dest), bytes);
          printJson({ artifactId, dest: resolve(dest), bytes: bytes.length });
        } else {
          usage();
        }
        break;
      }
      case "events": {
        expectPositional(positional, 0, 0);
        if (projectId === null) usage();
        const scope = { workspaceId: env.workspaceId, projectId };
        const after = Number.parseInt(flagString(flags, "after") ?? "0", 10);
        const rows = env.store.projectEventsAfter(scope, after, 500);
        printJson(
          rows.map((r) => ({
            seq: r["seq"],
            jobId: r["job_id"],
            createdAt: r["created_at"],
            event: JSON.parse(r["event_json"] as string),
          })),
        );
        break;
      }
      case "patch": {
        const sub = positional[0];
        if (projectId === null) usage();
        const scope = { workspaceId: env.workspaceId, projectId };
        if (sub === "propose") {
          expectPositional(positional, 1, 1);
          const opsPath = flagString(flags, "ops");
          if (opsPath === null) usage();
          const input = readOpsFile(opsPath);
          const baseSnapshotId =
            flagString(flags, "snapshot") ??
            (env.store.getProject(scope)?.["head_snapshot_id"] as string | null);
          if (baseSnapshotId === null) {
            fail(new WorkbenchError(ERROR_CODES.NOT_FOUND, "project has no snapshot to base a patch on"));
          }
          printJson(
            proposePatch({
              store: env.store,
              blobs: env.blobs,
              ctx,
              scope,
              baseSnapshotId,
              operations: input.operations,
              reason: input.reason,
              citekeyMapping: input.citekeyMapping,
            }),
          );
        } else if (sub === "apply") {
          expectPositional(positional, 1, 1);
          const patchId = flagString(flags, "patch");
          if (patchId === null) usage();
          printJson(applyPatch({ store: env.store, blobs: env.blobs, ctx, scope, patchId }));
        } else if (sub === "revert") {
          expectPositional(positional, 1, 1);
          const patchId = flagString(flags, "patch");
          if (patchId === null) usage();
          printJson(
            proposeRevert({
              store: env.store,
              blobs: env.blobs,
              ctx,
              scope,
              patchId,
              reason: flagString(flags, "reason") ?? `revert ${patchId}`,
            }),
          );
        } else if (sub === "show") {
          expectPositional(positional, 1, 1);
          const patchId = flagString(flags, "patch");
          if (patchId === null) usage();
          const row = env.store.getPatch(scope, patchId);
          if (row === null) fail(new WorkbenchError(ERROR_CODES.NOT_FOUND, `patch ${patchId} not found`));
          const stored = JSON.parse(row["operations_json"] as string) as Record<string, unknown>;
          printJson({
            patchId: row["patch_id"],
            state: row["state"],
            baseSnapshotId: row["base_snapshot_id"],
            resultSnapshotId: row["result_snapshot_id"],
            digest: row["patch_digest"],
            reason: stored["reason"],
            operations: stored["operations"],
            protectedChanges: JSON.parse(row["protected_changes_json"] as string),
            createdAt: row["created_at"],
          });
        } else {
          usage();
        }
        break;
      }
      case "approve": {
        expectPositional(positional, 0, 0);
        if (projectId === null) usage();
        const scope = { workspaceId: env.workspaceId, projectId };
        const patchId = flagString(flags, "patch");
        const explicitDigest = flagString(flags, "digest");
        let action: string;
        let scopeDigest: string;
        let baseSnapshotId: string;
        if (patchId !== null) {
          // Patch-bound grant: digest + base come from the patch row.
          const patch = env.store.getPatch(scope, patchId);
          if (patch === null) fail(new WorkbenchError(ERROR_CODES.NOT_FOUND, `patch ${patchId} not found`));
          action = flagString(flags, "action") ?? "patch.apply";
          scopeDigest = patch["patch_digest"] as string;
          baseSnapshotId = patch["base_snapshot_id"] as string;
        } else {
          // Action-bound grant (e.g. release.package): the caller supplies the
          // scope digest printed by the gate, the action, and the base snapshot.
          const a = flagString(flags, "action");
          const snap = flagString(flags, "snapshot");
          if (explicitDigest === null || a === null || snap === null) {
            usage();
          }
          action = a as string;
          scopeDigest = explicitDigest as string;
          baseSnapshotId = snap as string;
          if (!/^[a-f0-9]{64}$/.test(scopeDigest)) {
            fail(new WorkbenchError(ERROR_CODES.INVALID_REQUEST, "--digest must be a 64-hex sha256"));
          }
          if (env.store.getSnapshot(scope, baseSnapshotId) === null) {
            fail(new WorkbenchError(ERROR_CODES.NOT_FOUND, `snapshot ${baseSnapshotId} not found`));
          }
        }
        const grant = grantApproval({
          store: env.store,
          scope,
          hostPrincipal: ctx.principalId, // host-resolved identity, never file/tool content
          action,
          scopeDigest,
          baseSnapshotId,
          policyId: ctx.policyId,
          expiresInSeconds: Number.parseInt(flagString(flags, "expires-in-seconds") ?? "3600", 10),
        });
        printJson(grant);
        break;
      }
      case "approvals": {
        const sub = positional[0];
        if (projectId === null) usage();
        const scope = { workspaceId: env.workspaceId, projectId };
        if (sub === "list") {
          expectPositional(positional, 1, 1);
          env.store.expireApprovals(scope, new Date().toISOString());
          printJson(
            env.store.listApprovals(scope).map((r) => ({
              approvalId: r["approval_id"],
              principalId: r["principal_id"],
              action: r["action"],
              scopeDigest: r["scope_digest"],
              baseSnapshotId: r["base_snapshot_id"],
              policyId: r["policy_id"],
              expiresAt: r["expires_at"],
              state: r["state"],
            })),
          );
        } else if (sub === "revoke") {
          expectPositional(positional, 2, 2);
          const approvalId = positional[1] as string;
          const ok = revokeApproval({ store: env.store, scope, approvalId });
          printJson({ approvalId, revoked: ok });
        } else {
          usage();
        }
        break;
      }
      case "materialize": {
        const sub = positional[0] === "recover" ? "recover" : "apply";
        const consumed = sub === "recover" ? 1 : 0;
        expectPositional(positional, consumed, consumed);
        if (projectId === null) usage();
        const dir = flagString(flags, "dir");
        if (dir === null) usage();
        const scope = { workspaceId: env.workspaceId, projectId };
        if (sub === "recover") {
          printJson(
            recoverMaterialization({
              store: env.store,
              blobs: env.blobs,
              ctx,
              scope,
              hostDir: resolve(dir),
            }) ?? { state: "nothing-to-recover" },
          );
        } else {
          const snapshotId =
            flagString(flags, "snapshot") ??
            (env.store.getProject(scope)?.["head_snapshot_id"] as string | null);
          if (snapshotId === null) {
            fail(new WorkbenchError(ERROR_CODES.NOT_FOUND, "project has no snapshot to materialize"));
          }
          printJson(
            materializeToHost({
              store: env.store,
              blobs: env.blobs,
              ctx,
              scope,
              snapshotId,
              hostDir: resolve(dir),
              takeover: flags.get("takeover") === true,
            }),
          );
        }
        break;
      }
      case "assets": {
        const sub = positional[0];
        if (sub !== "inspect") usage();
        expectPositional(positional, 2, 2);
        if (projectId === null) usage();
        const scope = { workspaceId: env.workspaceId, projectId };
        const project = env.store.getProject(scope);
        if (project === null) {
          fail(new WorkbenchError(ERROR_CODES.NOT_FOUND, `project ${projectId} not found`));
        }
        const snapshotId =
          flagString(flags, "snapshot") ?? (project["head_snapshot_id"] as string | null);
        if (snapshotId === null) {
          fail(new WorkbenchError(ERROR_CODES.NOT_FOUND, "project has no snapshot"));
        }
        printJson(
          await inspectSourceAsset(
            {
              store: env.store,
              blobs: env.blobs,
              ctx,
              scope,
              repoRoot,
              hostPolicy: hostPolicy(),
              presetsDir: join(repoRoot, "runtime", "presets"),
            },
            { snapshotId, sourceAssetId: positional[1] as string },
          ),
        );
        break;
      }
      case "workflow": {
        const sub = positional[0];
        const deps: WorkflowDeps = {
          store: env.store,
          blobs: env.blobs,
          repoRoot,
          buildService: buildService(env),
          ctx,
        };
        const workflowScope = (): { workspaceId: string; projectId: string } => {
          if (projectId !== null) return { workspaceId: env.workspaceId, projectId };
          // status/resume/cancel may omit --project: resolve the owning
          // project from the (workspace-scoped) workflow id.
          const workflowId = positional[1];
          const owner =
            workflowId === undefined
              ? null
              : env.store.findWorkflowProject(env.workspaceId, workflowId);
          if (owner === null || owner === undefined) {
            fail(new WorkbenchError(ERROR_CODES.NOT_FOUND, `workflow ${workflowId ?? "?"} not found (or pass --project)`));
          }
          return { workspaceId: env.workspaceId, projectId: owner as string };
        };
        if (sub === "start") {
          expectPositional(positional, 2, 2);
          if (projectId === null) usage();
          const scope = { workspaceId: env.workspaceId, projectId };
          const contextPath = flagString(flags, "context");
          const context = contextPath !== null ? readWorkflowContext(contextPath) : undefined;
          printJson(
            await startWorkflow(deps, {
              scope,
              definitionId: positional[1] as string,
              ...(context !== undefined ? { context } : {}),
            }),
          );
        } else if (sub === "status") {
          expectPositional(positional, 2, 2);
          printJson(getWorkflowStatus(env.store, workflowScope(), positional[1] as string));
        } else if (sub === "resume") {
          expectPositional(positional, 2, 2);
          const inputPath = flagString(flags, "input");
          const input = inputPath !== null ? readJsonFile(inputPath) : undefined;
          printJson(
            await resumeWorkflow(deps, {
              scope: workflowScope(),
              workflowId: positional[1] as string,
              input,
            }),
          );
        } else if (sub === "cancel") {
          expectPositional(positional, 2, 2);
          printJson(cancelWorkflow(deps, { scope: workflowScope(), workflowId: positional[1] as string }));
        } else if (sub === "list") {
          expectPositional(positional, 1, 1);
          if (projectId === null) usage();
          printJson(listWorkflows(env.store, { workspaceId: env.workspaceId, projectId }));
        } else {
          usage();
        }
        break;
      }
      case "render": {
        const sub = positional[0];
        if (projectId === null) usage();
        const scope = { workspaceId: env.workspaceId, projectId };
        const artifactId = flagString(flags, "artifact");
        if (artifactId === null) usage();
        const pagesFlag = flagString(flags, "pages");
        const pages = pagesFlag === null
          ? undefined
          : pagesFlag.split(",").map((s) => {
              const n = Number.parseInt(s.trim(), 10);
              if (!Number.isInteger(n) || n < 1) {
                fail(new WorkbenchError(ERROR_CODES.INVALID_REQUEST, `--pages entry ${JSON.stringify(s)} is not a positive integer`));
              }
              return n;
            });
        if (sub === "pages") {
          const preset = flagString(flags, "preset") ?? "screen";
          printJson(
            await renderPages(
              {
                store: env.store, blobs: env.blobs, ctx, scope, repoRoot,
                hostPolicy: hostPolicy(),
              },
              {
                artifactId,
                renderPresetId: preset,
                ...(pages !== undefined ? { pages } : {}),
              },
            ),
          );
        } else if (sub === "text") {
          printJson(
            await renderText(
              {
                store: env.store, blobs: env.blobs, ctx, scope, repoRoot,
                hostPolicy: hostPolicy(),
              },
              { artifactId, ...(pages !== undefined ? { pages } : {}) },
            ),
          );
        } else {
          usage();
        }
        break;
      }
      case "check": {
        const sub = positional[0] ?? "run";
        if (projectId === null) usage();
        const scope = { workspaceId: env.workspaceId, projectId };
        if (sub === "run") {
          const artifactId = flagString(flags, "artifact");
          if (artifactId === null) usage();
          const rulesetId = flagString(flags, "ruleset") ?? "release";
          const baseline = flagString(flags, "baseline");
          const profile = flagString(flags, "profile");
          const common = {
            store: env.store, blobs: env.blobs, ctx, scope,
            hostPolicy: hostPolicy(),
          };
          if (rulesetId === "release") {
            printJson(
              (await runReleaseChecks(
                { ...common, repoRoot },
                {
                  artifactId,
                  rulesetId,
                  ...(profile !== null ? { releaseProfileId: profile as ReleaseProfileId } : {}),
                  ...(baseline !== null ? { baselineArtifactId: baseline } : {}),
                },
              )).report,
            );
          } else if (rulesetId === "draft") {
            printJson(
              (await runDraftChecks(
                { ...common, repoRoot },
                {
                  artifactId,
                  rulesetId,
                  ...(baseline !== null ? { baselineArtifactId: baseline } : {}),
                },
              )).report,
            );
          } else {
            printJson(
              (await runDataAssetChecks(common, {
                artifactId,
                rulesetId,
                ...(baseline !== null ? { baselineArtifactId: baseline } : {}),
              })).report,
            );
          }
        } else if (sub === "report") {
          const reportArtifactId = flagString(flags, "report");
          if (reportArtifactId === null) usage();
          printJson(
            readCheckReport(
              { store: env.store, blobs: env.blobs, ctx, scope, hostPolicy: hostPolicy() },
              { reportArtifactId },
            ),
          );
        } else {
          usage();
        }
        break;
      }
      case "review": {
        const sub = positional[0];
        if (projectId === null) usage();
        const scope = { workspaceId: env.workspaceId, projectId };
        const artifactId = flagString(flags, "artifact");
        if (sub === "coverage") {
          if (artifactId === null) usage();
          printJson(pageReviewCoverage(env.store, scope, artifactId));
        } else {
          if (artifactId === null) usage();
          const verdict = flagString(flags, "verdict");
          if (verdict === null) usage();
          printJson(
            submitPageReview(
              { store: env.store, blobs: env.blobs, ctx, scope },
              {
                pageArtifactId: artifactId,
                verdict,
                ...(flagString(flags, "note") !== null ? { note: flagString(flags, "note") as string } : {}),
              },
            ),
          );
        }
        break;
      }
      case "release": {
        const sub = positional[0];
        if (projectId === null) usage();
        const scope = { workspaceId: env.workspaceId, projectId };
        const releaseDeps = {
          store: env.store,
          blobs: env.blobs,
          ctx,
          scope,
          repoRoot,
          hostPolicy: hostPolicy(),
          buildService: buildService(env),
        };
        const profile = (): ReleaseProfileId => {
          const p = flagString(flags, "profile") ?? "submission";
          if (p !== "draft" && p !== "review" && p !== "submission") {
            fail(new WorkbenchError(ERROR_CODES.INVALID_REQUEST, `--profile must be draft|review|submission, got ${JSON.stringify(p)}`));
          }
          return p;
        };
        if (sub === "prepare") {
          const snapshotId = flagString(flags, "snapshot");
          const targetId = flagString(flags, "target");
          if (snapshotId === null || targetId === null) usage();
          printJson(await prepareRelease(releaseDeps, { snapshotId, targetId, releaseProfileId: profile() }));
        } else if (sub === "freeze") {
          const snapshotId = flagString(flags, "snapshot");
          const targetId = flagString(flags, "target");
          if (snapshotId === null || targetId === null) usage();
          const frozen = await freezeRelease(releaseDeps, { snapshotId, targetId, releaseProfileId: profile() });
          printJson({
            ...frozen,
            approvalDigest: releaseApprovalDigest(frozen.releaseId, snapshotId, targetId, env.store, scope),
          });
        } else if (sub === "package") {
          const releaseId = flagString(flags, "release");
          const artifactId = flagString(flags, "artifact");
          const baseline = flagString(flags, "baseline");
          if (releaseId === null || artifactId === null) usage();
          printJson(
            await packageRelease(releaseDeps, {
              releaseId,
              pdfArtifactId: artifactId,
              ...(baseline !== null ? { baselineArtifactId: baseline } : {}),
            }),
          );
        } else if (sub === "list") {
          if (env.store.getProject(scope) === null) {
            fail(new WorkbenchError(ERROR_CODES.NOT_FOUND, `project ${projectId} not found`));
          }
          printJson(env.store.listReleases(scope).map((r) => ({
            releaseId: r["release_id"],
            snapshotId: r["snapshot_id"],
            targetId: r["target_id"],
            status: r["status"],
            createdAt: r["created_at"],
          })));
        } else if (sub === "status") {
          const releaseId = positional[1] ?? flagString(flags, "release");
          if (releaseId === null || releaseId === undefined) usage();
          const row = env.store.getRelease(scope, releaseId as string);
          if (row === null) fail(new WorkbenchError(ERROR_CODES.NOT_FOUND, `release ${releaseId} not found`));
          printJson({
            releaseId: row["release_id"],
            snapshotId: row["snapshot_id"],
            targetId: row["target_id"],
            status: row["status"],
            approvalDigest: releaseApprovalDigest(
              row["release_id"] as string,
              row["snapshot_id"] as string,
              row["target_id"] as string,
              env.store,
              scope,
            ),
            manifest: JSON.parse(row["manifest_json"] as string),
            createdAt: row["created_at"],
          });
        } else {
          usage();
        }
        break;
      }
      case "export": {
        const sub = positional[0];
        if (projectId === null) usage();
        const scope = { workspaceId: env.workspaceId, projectId };
        const releaseDeps = {
          store: env.store,
          blobs: env.blobs,
          ctx,
          scope,
          repoRoot,
          hostPolicy: hostPolicy(),
          buildService: buildService(env),
        };
        const snapshotId = flagString(flags, "snapshot");
        const targetId = flagString(flags, "target");
        const p = flagString(flags, "profile") ?? "submission";
        if (p !== "draft" && p !== "review" && p !== "submission") {
          fail(new WorkbenchError(ERROR_CODES.INVALID_REQUEST, `--profile must be draft|review|submission`));
        }
        if (sub === "prepare") {
          if (snapshotId === null || targetId === null) usage();
          const out = await prepareRelease(releaseDeps, {
            snapshotId, targetId, releaseProfileId: p,
          });
          printJson(out.plan);
        } else if (sub === "package") {
          // Contract ExportInput carries (snapshotId,targetId,profile) — the
          // release row is created implicitly (freeze) then packaged.
          if (snapshotId === null || targetId === null) usage();
          const artifactId = flagString(flags, "artifact");
          const baseline = flagString(flags, "baseline");
          const frozen = await freezeRelease(releaseDeps, {
            snapshotId, targetId, releaseProfileId: p,
          });
          if (artifactId === null) {
            fail(new WorkbenchError(ERROR_CODES.INVALID_REQUEST, "export package requires --artifact <pdfId> (the compiled pdf of the frozen snapshot)"));
          }
          printJson(
            (await packageRelease(releaseDeps, {
              releaseId: frozen.releaseId,
              pdfArtifactId: artifactId,
              ...(baseline !== null ? { baselineArtifactId: baseline } : {}),
            })).result,
          );
        } else {
          usage();
        }
        break;
      }
      default:
        if (UNIMPLEMENTED.has(command ?? "")) {
          fail(new NotImplementedError(`cli.${command}`, "tracked in docs/UNSUPPORTED.md"));
        }
        usage();
    }
  } catch (error) {
    fail(error);
  }
  process.exit(0);
}

main(process.argv.slice(2));
