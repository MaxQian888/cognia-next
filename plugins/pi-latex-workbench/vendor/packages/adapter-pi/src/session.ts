/**
 * Session-bound workbench service for the Pi adapter.
 *
 * The RequestContext is host-owned: workspace, project, principal, session
 * and policy come from extension-level configuration (environment), never
 * from tool parameters. Tool params carry a `projectId` that must equal the
 * session's bound project — anything else is POLICY_DENIED.
 */
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { ERROR_CODES, WorkbenchError, type HostPolicy } from "@latexwb/contracts";
import {
  openDatabase,
  migrate,
  WorkbenchStore,
  BlobStore,
  type Scope,
} from "@latexwb/storage";
import {
  BuildService,
  createRequestContext,
  type Capability,
  type ProtectionMode,
  type RequestContext,
} from "@latexwb/core";
import type { DatabaseSync } from "node:sqlite";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = join(here, "..", "..", "..");

/**
 * Capability ceiling for model-driven tool calls — the most any tool may
 * request. Per API_CONTRACT §2 the tool surface includes release.create (the
 * release pipeline's actual gate is approval.grant + human.review, which
 * remain host-only: a tool can freeze/package but can never approve its own
 * release or self-review pages). Deliberately excluded: approval.grant,
 * human.review. Each tool dispatch narrows this further via
 * requestContextFor() per action (e.g. metadata.lookup only for bib
 * lookup/resolve, data.render only for figure/check). `project.write` is
 * granted because latex_patch apply is a contracted action — applyPatch
 * still enforces host approvals for protected content internally.
 */
export const TOOL_CAPABILITIES: readonly Capability[] = [
  "project.read",
  "project.write",
  "build.execute",
  "artifact.read",
  "skill.resource.read",
  "metadata.lookup",
  "data.render",
  "release.create",
];

export interface WorkbenchSessionConfig {
  workspaceId: string;
  /** Bound project. null = unbound; every tool call then fails loudly. */
  projectId: string | null;
  principalId: string;
  sessionId: string;
  policyId: string;
  stateDir: string;
  repoRoot: string;
  /**
   * Host-chosen protection mode from LATEXWB_PROTECTION (ADR-0007), or null
   * to defer to host-policy `protection.mode` (default "strict").
   */
  protection?: ProtectionMode | null;
}

const PROTECTION_MODES: readonly ProtectionMode[] = ["strict", "authoring"];

function parseProtection(raw: string | undefined): ProtectionMode | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = raw.trim().toLowerCase();
  if ((PROTECTION_MODES as readonly string[]).includes(value)) return value as ProtectionMode;
  // An unrecognized value must never widen permissions.
  process.stderr.write(`latexwb: ignoring LATEXWB_PROTECTION=${JSON.stringify(raw)} (expected strict|authoring); using strict\n`);
  return "strict";
}

export class WorkbenchSession {
  readonly config: WorkbenchSessionConfig;
  readonly store: WorkbenchStore;
  readonly blobs: BlobStore;
  readonly buildService: BuildService;
  readonly db: DatabaseSync;
  /**
   * Set when the session_start read-back proves the tool boundary cannot be
   * enforced (host tools still active). Every tool call then returns a
   * failed envelope instead of running inside a broken sandbox.
   */
  boundaryBroken = false;
  /** Human-readable reason recorded when boundaryBroken is set. */
  boundaryBrokenReason: string | null = null;
  /**
   * Session override set by the human operator (`/latex mode …` or the
   * approval dialog). Never settable from tool parameters.
   */
  protectionOverride: ProtectionMode | null = null;

  constructor(config: WorkbenchSessionConfig) {
    this.config = config;
    mkdirSync(join(config.stateDir, "blobs"), { recursive: true });
    mkdirSync(join(config.stateDir, "jobs"), { recursive: true });
    this.db = openDatabase(join(config.stateDir, "workbench.db"));
    migrate(this.db, join(config.repoRoot, "migrations"));
    this.store = new WorkbenchStore(this.db);
    this.blobs = new BlobStore(config.stateDir);
    this.buildService = new BuildService({
      store: this.store,
      blobs: this.blobs,
      repoRoot: config.repoRoot,
      hostPolicyPath: join(config.repoRoot, "runtime/host-policy.json"),
      presetsDir: join(config.repoRoot, "runtime/presets"),
      workRoot: join(config.stateDir, "jobs"),
      workerId: `pi-${process.pid}`,
    });
  }

  /**
   * Host-owned configuration. Environment variables are the host channel —
   * tool parameters never feed this. LATEXWB_PROJECT selects the single
   * bound project; when absent the session is unbound and tools deny work.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): WorkbenchSession {
    const stateDir = resolve(env["LATEXWB_STATE"] ?? "./.latexwb");
    return new WorkbenchSession({
      workspaceId: env["LATEXWB_WORKSPACE"] ?? "local",
      projectId: env["LATEXWB_PROJECT"] ?? null,
      principalId: env["LATEXWB_PRINCIPAL"] ?? "pi-operator",
      sessionId: env["LATEXWB_SESSION"] ?? `pi-${process.pid}`,
      policyId: env["LATEXWB_POLICY"] ?? "default",
      stateDir,
      repoRoot: env["LATEXWB_REPO_ROOT"] !== undefined
        ? resolve(env["LATEXWB_REPO_ROOT"])
        : DEFAULT_REPO_ROOT,
      protection: parseProtection(env["LATEXWB_PROTECTION"]),
    });
  }

  /**
   * Effective protection mode: operator override → LATEXWB_PROTECTION →
   * host-policy `protection.mode` → "strict". All three sources are host
   * channels; the model can read the result but never set it.
   */
  protectionMode(): ProtectionMode {
    return (
      this.protectionOverride ??
      this.config.protection ??
      this.hostPolicy()?.protection?.mode ??
      "strict"
    );
  }

  /** Fresh host-owned RequestContext for one tool call (full tool ceiling). */
  requestContext(idempotencyKey?: string): RequestContext {
    return createRequestContext({
      workspaceId: this.config.workspaceId,
      principalId: this.config.principalId,
      sessionId: this.config.sessionId,
      policyId: this.config.policyId,
      grantedCapabilities: TOOL_CAPABILITIES,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    });
  }

  /**
   * Per-action RequestContext: grants the INTERSECTION of the requested set
   * with TOOL_CAPABILITIES. The requested set is a host-side constant per
   * action — never derived from tool parameters — so a tool cannot widen
   * itself past the ceiling by naming extra capabilities.
   */
  requestContextFor(
    capabilities: readonly Capability[],
    idempotencyKey?: string,
  ): RequestContext {
    const granted = capabilities.filter((c) => TOOL_CAPABILITIES.includes(c));
    return createRequestContext({
      workspaceId: this.config.workspaceId,
      principalId: this.config.principalId,
      sessionId: this.config.sessionId,
      policyId: this.config.policyId,
      grantedCapabilities: granted,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    });
  }

  /** Host policy file — parsed fresh so edits between calls take effect. */
  hostPolicy(): HostPolicy | null {
    try {
      return JSON.parse(
        readFileSync(join(this.config.repoRoot, "runtime", "host-policy.json"), "utf8"),
      ) as HostPolicy;
    } catch {
      return null;
    }
  }

  /** Build presets directory (host-owned). */
  presetsDir(): string {
    return join(this.config.repoRoot, "runtime", "presets");
  }

  /**
   * Project binding enforcement. Returns the scope iff the caller's
   * projectId equals the session's bound project.
   */
  scopeFor(projectId: string): Scope {
    const bound = this.config.projectId;
    if (bound === null) {
      throw new WorkbenchError(
        ERROR_CODES.POLICY_DENIED,
        "this Pi session is not bound to a project (LATEXWB_PROJECT unset); tool calls are denied",
      );
    }
    if (projectId !== bound) {
      throw new WorkbenchError(
        ERROR_CODES.POLICY_DENIED,
        `cross-project tool call denied: session is bound to project ${JSON.stringify(bound)}, got ${JSON.stringify(projectId)}`,
      );
    }
    return { workspaceId: this.config.workspaceId, projectId: bound };
  }

  /** Head snapshot of the bound project, or null when it has none. */
  headSnapshotId(scope: Scope): string | null {
    const project = this.store.getProject(scope);
    if (project === null) {
      throw new WorkbenchError(
        ERROR_CODES.NOT_FOUND,
        `project ${scope.projectId} does not exist yet — for a new document, create it with ` +
          `latex_project {action:"init", templateId, targetId} using an approved template ` +
          `(listed in the system context); to work on existing files, the host must import them first`,
      );
    }
    return project["head_snapshot_id"] as string | null;
  }

  /** Registered host root (import source) of the bound project, or null. */
  hostRoot(scope: Scope): string | null {
    const project = this.store.getProject(scope);
    if (project === null) {
      throw new WorkbenchError(
        ERROR_CODES.NOT_FOUND,
        `project ${scope.projectId} not found`,
      );
    }
    return project["host_root"] as string | null;
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}
