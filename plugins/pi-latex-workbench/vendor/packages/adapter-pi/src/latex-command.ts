/**
 * The /latex command: host-side routing to committed services.
 *
 * Argument parsing is CLOSED — unknown subcommands, unknown flags, and
 * stray positionals are errors, matching the CLI convention. No argument
 * is a host path: ids are validated against the id grammar, and anything
 * containing a path separator or drive letter is rejected outright.
 */
import { ERROR_CODES, WorkbenchError, type ProtectedChange } from "@latexwb/contracts";
import {
  cancelWorkflow,
  getWorkflowStatus,
  grantApproval,
  initApprovedProject,
  listWorkflows,
  materializeToHost,
  startWorkflow,
  type WorkflowContext,
} from "@latexwb/core";
import { buildDoctorReportFull } from "@latexwb/runtime";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { summarizeProtected } from "./approval.ts";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Scope } from "@latexwb/storage";
import type { WorkbenchSession } from "./session.ts";

const SUBCOMMANDS = [
  "doctor",
  "init",
  "build",
  "repair",
  "review",
  "bib",
  "figure",
  "migrate",
  "release",
  "status",
  "cancel",
  "pending",
  "approve",
  "mode",
  "pdf",
  "sync",
] as const;

/** Subcommands that accept positional ids/values. */
const POSITIONAL_OK = new Set(["status", "cancel", "approve", "mode", "pdf"]);
/** Flags that take no value. */
const BOOLEAN_FLAGS = new Set(["clean", "open", "takeover"]);

const UNIMPLEMENTED: Record<string, string> = {};

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

interface Parsed {
  subcommand: string;
  positional: string[];
  flags: Map<string, string | boolean>;
}

const KNOWN_FLAGS: Record<string, ReadonlySet<string>> = {
  build: new Set(["snapshot", "target", "preset", "clean"]),
  init: new Set(["template", "target"]),
  bib: new Set(["snapshot"]),
  figure: new Set(["snapshot"]),
  migrate: new Set(["snapshot"]),
  review: new Set(["snapshot"]),
  release: new Set(["snapshot", "target", "profile", "baseline"]),
  status: new Set([]),
  cancel: new Set(["workflow"]),
  pending: new Set([]),
  approve: new Set([]),
  mode: new Set([]),
  pdf: new Set(["open"]),
  sync: new Set(["snapshot", "takeover"]),
};

/** Workflow definition ids the /latex subcommands start (host-owned defs). */
const SUBCOMMAND_WORKFLOWS: Record<string, string> = {
  bib: "bibliography",
  figure: "data-assets",
  migrate: "template-migration",
  review: "revise",
};

function parseArgs(args: string): Parsed {
  const tokens = args.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `usage: /latex <${SUBCOMMANDS.join("|")}> [flags]`,
    );
  }
  const subcommand = tokens[0] as string;
  if (!(SUBCOMMANDS as readonly string[]).includes(subcommand)) {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `unknown /latex subcommand ${JSON.stringify(subcommand)}; expected one of ${SUBCOMMANDS.join(", ")}`,
    );
  }
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i] as string;
    if (tok.startsWith("--")) {
      const name = tok.slice(2);
      const known = KNOWN_FLAGS[subcommand];
      if (known === undefined || !known.has(name)) {
        throw new WorkbenchError(
          ERROR_CODES.INVALID_REQUEST,
          `unknown flag --${name} for /latex ${subcommand}`,
        );
      }
      if (flags.has(name)) {
        throw new WorkbenchError(ERROR_CODES.INVALID_REQUEST, `duplicate flag --${name}`);
      }
      if (BOOLEAN_FLAGS.has(name)) {
        flags.set(name, true);
      } else if (i + 1 < tokens.length && !(tokens[i + 1] as string).startsWith("--")) {
        flags.set(name, tokens[i + 1] as string);
        i += 1;
      } else {
        throw new WorkbenchError(ERROR_CODES.INVALID_REQUEST, `--${name} requires a value`);
      }
    } else {
      positional.push(tok);
    }
  }
  if (!POSITIONAL_OK.has(subcommand) && positional.length > 0) {
    throw new WorkbenchError(ERROR_CODES.INVALID_REQUEST, `/latex ${subcommand} takes no positional arguments`);
  }
  // No argument is a host path or URL: anything carrying a path separator,
  // a drive prefix or a scheme is rejected. Ids use the workbench grammar.
  for (const value of [...positional, ...[...flags.values()].filter((v): v is string => typeof v === "string")]) {
    if (/[/\\]/.test(value) || /^[A-Za-z]:/.test(value) || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      throw new WorkbenchError(
        ERROR_CODES.POLICY_DENIED,
        `/latex ${subcommand} does not accept host paths or URLs; got ${JSON.stringify(value)}`,
      );
    }
  }
  return { subcommand, positional, flags };
}

function flagId(flags: Map<string, string | boolean>, name: string): string | null {
  const v = flags.get(name);
  return typeof v === "string" ? v : null;
}

function requireId(value: string, what: string): string {
  if (!ID_PATTERN.test(value)) {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `${what} ${JSON.stringify(value)} is not a valid id`,
    );
  }
  return value;
}

function emit(ctx: ExtensionCommandContext | null, value: unknown, report?: (value: unknown) => void): void {
  if (report !== undefined) { report(value); return; }
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (ctx !== null && ctx.hasUI) {
    ctx.ui.notify(text, "info");
  }
  process.stdout.write(`${text}\n`);
}

export async function handleLatexCommand(
  args: string,
  session: WorkbenchSession,
  ctx: ExtensionCommandContext | null = null,
  report?: (value: unknown) => void,
): Promise<void> {
  const output = (value: unknown) => emit(ctx, value, report);
  try {
    const parsed = parseArgs(args);
    const bound = session.config.projectId;
    const needProject = (): Scope => {
      if (session.boundaryBroken) {
        throw new WorkbenchError(ERROR_CODES.POLICY_DENIED, `controlled-session boundary is broken: ${session.boundaryBrokenReason}`);
      }
      if (bound === null) {
        throw new WorkbenchError(
          ERROR_CODES.POLICY_DENIED,
          "this Pi session is not bound to a project (LATEXWB_PROJECT unset)",
        );
      }
      return { workspaceId: session.config.workspaceId, projectId: bound };
    };
    switch (parsed.subcommand) {
      case "doctor": {
        const report = await buildDoctorReportFull({
          repoRoot: session.config.repoRoot,
          hostPolicyPath: join(session.config.repoRoot, "runtime/host-policy.json"),
          toolchainLockPath: join(session.config.repoRoot, "runtime/toolchain-lock.json"),
        });
        output(report);
        return;
      }
      case "build": {
        const scope = needProject();
        const outcome = await session.buildService.build(scope, session.requestContext(), {
          snapshotId: flagId(parsed.flags, "snapshot"),
          targetId: flagId(parsed.flags, "target"),
          presetId: flagId(parsed.flags, "preset"),
          clean: parsed.flags.get("clean") === true,
        });
        output(outcome.jobResult);
        return;
      }
      case "init": {
        const scope = needProject();
        const templateId = flagId(parsed.flags, "template");
        const targetId = flagId(parsed.flags, "target");
        if (templateId === null || targetId === null) {
          throw new WorkbenchError(
            ERROR_CODES.INVALID_REQUEST,
            "usage: /latex init --template <approved-template-id> --target <target-id>",
          );
        }
        const out = initApprovedProject({
          store: session.store,
          blobs: session.blobs,
          ctx: session.requestContextFor(["project.write", "project.read"]),
          scope,
          repoRoot: session.config.repoRoot,
          templateId: requireId(templateId, "templateId"),
          targetId: requireId(targetId, "targetId"),
        });
        output({
          snapshot: out.snapshot,
          target: out.target,
          files: out.files,
          createdProject: out.createdProject,
        });
        return;
      }
      case "repair": {
        const scope = needProject();
        if (parsed.positional.length !== 0) {
          throw new WorkbenchError(ERROR_CODES.INVALID_REQUEST, "/latex repair takes no arguments");
        }
        const status = await startWorkflow(
          {
            store: session.store,
            blobs: session.blobs,
            repoRoot: session.config.repoRoot,
            buildService: session.buildService,
            ctx: session.requestContext(),
          },
          { scope, definitionId: "repair" },
        );
        output({
          workflowId: status.workflowId,
          state: status.state,
          currentNode: status.currentNode,
          pendingRequest: status.pendingRequest,
          steps: status.steps,
        });
        return;
      }
      case "release": {
        const scope = needProject();
        if (parsed.positional.length !== 0) {
          throw new WorkbenchError(ERROR_CODES.INVALID_REQUEST, "/latex release takes no positional arguments");
        }
        const context: Partial<WorkflowContext> = {};
        const snapshotFlag = flagId(parsed.flags, "snapshot");
        const targetFlag = flagId(parsed.flags, "target");
        const profileFlag = flagId(parsed.flags, "profile");
        const baselineFlag = flagId(parsed.flags, "baseline");
        if (snapshotFlag !== null) context.snapshotId = requireId(snapshotFlag, "snapshotId");
        if (targetFlag !== null) context.targetId = requireId(targetFlag, "targetId");
        if (profileFlag !== null) {
          if (!["draft", "review", "submission"].includes(profileFlag)) {
            throw new WorkbenchError(
              ERROR_CODES.INVALID_REQUEST,
              `--profile must be draft|review|submission, got ${JSON.stringify(profileFlag)}`,
            );
          }
          context.releaseProfileId = profileFlag;
        }
        if (baselineFlag !== null) context.baselineArtifactId = requireId(baselineFlag, "baselineArtifactId");
        const status = await startWorkflow(
          {
            store: session.store,
            blobs: session.blobs,
            repoRoot: session.config.repoRoot,
            buildService: session.buildService,
            ctx: session.requestContext(),
          },
          { scope, definitionId: "release", context },
        );
        output({
          workflowId: status.workflowId,
          definitionId: "release",
          state: status.state,
          currentNode: status.currentNode,
          pendingRequest: status.pendingRequest,
          steps: status.steps,
        });
        return;
      }
      case "bib":
      case "figure":
      case "migrate":
      case "review": {
        const scope = needProject();
        if (parsed.positional.length !== 0) {
          throw new WorkbenchError(
            ERROR_CODES.INVALID_REQUEST,
            `/latex ${parsed.subcommand} takes no positional arguments`,
          );
        }
        const definitionId = SUBCOMMAND_WORKFLOWS[parsed.subcommand] as string;
        const context: Partial<WorkflowContext> = {};
        const snapshotFlag = flagId(parsed.flags, "snapshot");
        if (snapshotFlag !== null) {
          context.snapshotId = requireId(snapshotFlag, "snapshotId");
        }
        const status = await startWorkflow(
          {
            store: session.store,
            blobs: session.blobs,
            repoRoot: session.config.repoRoot,
            buildService: session.buildService,
            ctx: session.requestContext(),
          },
          { scope, definitionId, context },
        );
        output({
          workflowId: status.workflowId,
          definitionId,
          state: status.state,
          currentNode: status.currentNode,
          pendingRequest: status.pendingRequest,
          steps: status.steps,
        });
        return;
      }
      case "status": {
        const scope = needProject();
        if (parsed.positional.length > 1) {
          throw new WorkbenchError(ERROR_CODES.INVALID_REQUEST, "/latex status takes at most one id");
        }
        if (parsed.positional.length === 1) {
          const id = requireId(parsed.positional[0] as string, "id");
          const job = session.buildService.jobService().get(scope, id);
          if (job !== null) {
            output(job);
            return;
          }
          output(getWorkflowStatus(session.store, scope, id));
          return;
        }
        const project = session.store.getProject(scope);
        output({
          projectId: scope.projectId,
          headSnapshotId: (project?.["head_snapshot_id"] as string | null) ?? null,
          jobs: session.buildService.jobService().list(scope, 20).map((j) => ({
            jobId: j.jobId,
            state: j.state,
            snapshotId: j.snapshotId,
          })),
          workflows: listWorkflows(session.store, scope).map((w) => ({
            workflowId: w.workflowId,
            definitionId: w.definitionId,
            state: w.state,
            currentNode: w.currentNode,
          })),
        });
        return;
      }
      case "cancel": {
        const scope = needProject();
        const workflowId = flagId(parsed.flags, "workflow");
        if (workflowId !== null) {
          if (parsed.positional.length !== 0) {
            throw new WorkbenchError(ERROR_CODES.INVALID_REQUEST, "/latex cancel --workflow takes no positional id");
          }
          output(cancelWorkflow(
            {
              store: session.store,
              blobs: session.blobs,
              repoRoot: session.config.repoRoot,
              buildService: session.buildService,
              ctx: session.requestContext(),
            },
            { scope, workflowId: requireId(workflowId, "workflowId") },
          ));
          return;
        }
        if (parsed.positional.length !== 1) {
          throw new WorkbenchError(ERROR_CODES.INVALID_REQUEST, "/latex cancel requires a job id (or --workflow <id>)");
        }
        const jobId = requireId(parsed.positional[0] as string, "jobId");
        const outcome = session.buildService.cancel(scope, jobId);
        output({ jobId, outcome });
        return;
      }
      case "pending": {
        const scope = needProject();
        const waiting = session.store.listPatches(scope, { state: "waiting-approval", limit: 20 });
        output({
          protectionMode: session.protectionMode(),
          pendingPatches: waiting.map((row) => {
            const changes = JSON.parse(row["protected_changes_json"] as string) as ProtectedChange[];
            const ops = JSON.parse(row["operations_json"] as string) as { reason?: string };
            return {
              patchId: row["patch_id"],
              baseSnapshotId: row["base_snapshot_id"],
              createdAt: row["created_at"],
              reason: ops.reason ?? "",
              protected: summarizeProtected(changes),
            };
          }),
          hint: waiting.length > 0
            ? "approve with /latex approve <patchId> (or the newest with /latex approve), then ask the agent to apply it"
            : "no patch is waiting for approval",
        });
        return;
      }
      case "approve": {
        // The operator typed this command; the model cannot issue slash
        // commands. The grant is the same digest-bound row `latexwb approve`
        // writes, attributed to the host principal.
        const scope = needProject();
        if (parsed.positional.length > 1) {
          throw new WorkbenchError(ERROR_CODES.INVALID_REQUEST, "usage: /latex approve [patchId]");
        }
        const requested = parsed.positional[0];
        const row = requested !== undefined
          ? session.store.getPatch(scope, requireId(requested, "patchId"))
          : session.store.listPatches(scope, { state: "waiting-approval", limit: 1 })[0] ?? null;
        if (row === null) {
          throw new WorkbenchError(
            ERROR_CODES.NOT_FOUND,
            requested !== undefined ? `patch ${requested} not found` : "no patch is waiting for approval",
          );
        }
        if ((row["state"] as string) !== "waiting-approval") {
          throw new WorkbenchError(
            ERROR_CODES.INVALID_REQUEST,
            `patch ${row["patch_id"] as string} is '${row["state"] as string}', not waiting for approval`,
          );
        }
        const grant = grantApproval({
          store: session.store,
          scope,
          hostPrincipal: session.config.principalId,
          action: "patch.apply",
          scopeDigest: row["patch_digest"] as string,
          baseSnapshotId: row["base_snapshot_id"] as string,
          policyId: session.config.policyId,
          expiresInSeconds: 3600,
          grantedVia: "pi-ui",
        });
        output({
          approved: row["patch_id"],
          approvalId: grant.approvalId,
          principal: grant.principalId,
          expiresAt: grant.expiresAt,
          protected: summarizeProtected(JSON.parse(row["protected_changes_json"] as string) as ProtectedChange[]),
          next: `ask the agent to apply ${row["patch_id"] as string}`,
        });
        return;
      }
      case "mode": {
        needProject();
        if (parsed.positional.length > 1) {
          throw new WorkbenchError(ERROR_CODES.INVALID_REQUEST, "usage: /latex mode [strict|authoring]");
        }
        const wanted = parsed.positional[0];
        if (wanted !== undefined) {
          if (wanted !== "strict" && wanted !== "authoring") {
            throw new WorkbenchError(ERROR_CODES.INVALID_REQUEST, `mode must be strict|authoring, got ${JSON.stringify(wanted)}`);
          }
          session.protectionOverride = wanted;
        }
        const mode = session.protectionMode();
        output({
          protectionMode: mode,
          meaning: mode === "authoring"
            ? "NEW protected content (equations, labels, citations, numbers, literal blocks, commands) applies without a per-patch grant; modifying or removing existing protected content still needs approval"
            : "every patch that touches protected content needs a host approval (the operator is asked in interactive sessions)",
        });
        return;
      }
      case "pdf": {
        const scope = needProject();
        if (parsed.positional.length > 1) {
          throw new WorkbenchError(ERROR_CODES.INVALID_REQUEST, "usage: /latex pdf [pdfArtifactId] [--open]");
        }
        const requested = parsed.positional[0];
        let artifactId: string;
        let snapshotId: string;
        if (requested !== undefined) {
          const row = session.store.getArtifact(scope, requireId(requested, "artifactId"));
          if (row === null || row["kind"] !== "pdf") {
            throw new WorkbenchError(ERROR_CODES.NOT_FOUND, `pdf artifact ${requested} not found`);
          }
          artifactId = requested;
          snapshotId = row["snapshot_id"] as string;
        } else {
          const head = (session.store.getProject(scope)?.["head_snapshot_id"] as string | null) ?? null;
          if (head === null) throw new WorkbenchError(ERROR_CODES.NOT_FOUND, "project has no head snapshot yet");
          const existing = session.store.listArtifactsBySnapshot(scope, head).filter((a) => a["kind"] === "pdf").at(-1);
          if (existing !== undefined) {
            artifactId = existing["artifact_id"] as string;
          } else {
            const built = await session.buildService.build(scope, session.requestContext(), { snapshotId: head, targetId: null });
            const pdf = built.jobResult.buildResult?.pdfArtifactId ?? null;
            if (pdf === null) {
              output({ error: { code: "BUILD_FAILED", message: "the head snapshot did not compile; no PDF to export", retryable: false }, build: built.jobResult });
              return;
            }
            artifactId = pdf;
          }
          snapshotId = head;
        }
        const row = session.store.getArtifact(scope, artifactId);
        const dir = join(session.config.stateDir, "exports", scope.projectId);
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${scope.projectId}-${snapshotId.replace(/^snap-/, "").slice(0, 8)}.pdf`);
        writeFileSync(file, session.blobs.getVerified(row?.["blob_hash"] as string));
        if (parsed.flags.get("open") === true) {
          const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
          try {
            spawn(opener, [file], { detached: true, stdio: "ignore" }).unref();
          } catch {
            // Opening is a convenience; the saved path below is the result.
          }
        }
        output({ saved: file, artifactId, snapshotId });
        return;
      }
      case "sync": {
        // Write a snapshot's sources back into the imported host directory
        // through the journaled materializer: external edits there are a
        // STALE_BASE conflict, never overwritten (unless --takeover on a
        // directory never synced before).
        const scope = needProject();
        const hostRoot = session.hostRoot(scope);
        if (hostRoot === null) {
          throw new WorkbenchError(
            ERROR_CODES.INVALID_REQUEST,
            "this project was not imported from a host directory, so there is nothing to sync back to; use /latex pdf or `latexwb materialize --dir` on the host",
          );
        }
        const snapshotFlag = flagId(parsed.flags, "snapshot");
        const snapshotId = snapshotFlag !== null
          ? requireId(snapshotFlag, "snapshotId")
          : (session.store.getProject(scope)?.["head_snapshot_id"] as string | null) ?? null;
        if (snapshotId === null) throw new WorkbenchError(ERROR_CODES.NOT_FOUND, "project has no head snapshot yet");
        const out = materializeToHost({
          store: session.store,
          blobs: session.blobs,
          ctx: session.requestContextFor(["project.write", "project.read"]),
          scope,
          snapshotId,
          hostDir: hostRoot,
          takeover: parsed.flags.get("takeover") === true,
        });
        output({ syncedTo: hostRoot, snapshotId, ...out });
        return;
      }
      default: {
        const reason = UNIMPLEMENTED[parsed.subcommand];
        if (reason === undefined) {
          throw new WorkbenchError(
            ERROR_CODES.INVALID_REQUEST,
            `unknown /latex subcommand ${JSON.stringify(parsed.subcommand)}`,
          );
        }
        output({ error: { code: ERROR_CODES.NOT_IMPLEMENTED, message: `/latex ${parsed.subcommand}: ${reason}`, retryable: false } });
        return;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof WorkbenchError ? err.code : ERROR_CODES.INVALID_REQUEST;
    output({ error: { code, message, retryable: false } });
  }
}
