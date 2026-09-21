/**
 * What the delegate workflow runs against (ADR-0188 B4, DESIGN §10).
 *
 * The workflow never touches a disk, a sandbox or a person. The host supplies:
 *
 * - a {@link WorkspacePort} — the target workspace's revision, reads at a
 *   revision, staging a patch into an isolated worktree (never the user's
 *   checkout), and the one write to the user's workspace: a compare-and-swap
 *   apply that refuses when the workspace moved (DEL-04);
 * - an {@link AcceptancePort} — the approved acceptance command of a
 *   `.cognia/workspace.json` profile, run on a staged revision in the
 *   strongest sandbox tier available, with no network;
 * - an {@link ApprovalPort} — the only way anything outside a subtask's
 *   allowed paths, or into the user's workspace, is permitted. It is asked, it
 *   never asks back, and nothing a model says reaches it as a decision;
 * - a {@link DelegateToolRuntime} — the worker's tools under policy
 *   `delegate-work-1`: read, list, and propose a patch;
 * - a {@link DelegateStepJournal} — the durable record of every step that is
 *   not a model call, so a replay after a crash or an approval wait returns
 *   what happened instead of doing it again, and a step that was dispatched
 *   and never answered is UNKNOWN rather than re-run (REC-06).
 *
 * Content rules the host owns: every read it returns to a model — a file, a
 * listing — has passed its path rules (no `..`, no absolute path, no symlink
 * out of the root, no credential-shaped name; DEL-05) and its PII gate
 * (`hasNoLeakingPii`), exactly as the panel's `workspace_read` does.
 */

import { z } from "zod"

import type { VerificationReport } from "../contracts/schemas"
import { canonicalHash, sha256Hex } from "../util/sha256"
import type { ToolContext, ToolDescriptor, ToolIntent, ToolReceipt } from "./ports"

// ── the worker's tool policy ──────────────────────────────────────────────────

/** Read, list, propose a patch; writes only inside the subtask's allowed paths. */
export const DELEGATE_WORK_POLICY = "delegate-work-1"

export const DELEGATE_TOOL_NAMES = {
  read: "workspace_read",
  list: "workspace_list",
  proposePatch: "propose_patch",
} as const

export type DelegateToolName = (typeof DELEGATE_TOOL_NAMES)[keyof typeof DELEGATE_TOOL_NAMES]

/** Bounds of one patch: files, bytes per file, bytes in all. */
export const DELEGATE_PATCH_LIMITS = {
  maxFiles: 64,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 1024 * 1024,
} as const

const PATH_ARG = { type: "string", description: "A path relative to the workspace root." }

export const DELEGATE_READ_TOOL: ToolDescriptor = {
  name: DELEGATE_TOOL_NAMES.read,
  description:
    "Read one text file of the subtask's workspace at its current revision, by its path relative to the workspace root.",
  parameters: {
    type: "object",
    required: ["path"],
    additionalProperties: false,
    properties: { path: PATH_ARG },
  },
  toolClass: "read_only",
}

export const DELEGATE_LIST_TOOL: ToolDescriptor = {
  name: DELEGATE_TOOL_NAMES.list,
  description:
    "List the files under a directory of the subtask's workspace; an empty prefix lists from the root.",
  parameters: {
    type: "object",
    required: ["prefix"],
    additionalProperties: false,
    properties: { prefix: { type: "string" } },
  },
  toolClass: "read_only",
}

export const DELEGATE_PROPOSE_PATCH_TOOL: ToolDescriptor = {
  name: DELEGATE_TOOL_NAMES.proposePatch,
  description:
    "Propose the full new content of one file, or its deletion. Only paths inside the subtask's allowed paths are accepted; anything else needs a person's approval. A proposal changes nothing until the runtime stages and verifies the patch.",
  parameters: {
    type: "object",
    required: ["path", "action"],
    additionalProperties: false,
    properties: {
      path: PATH_ARG,
      action: { type: "string", enum: ["write", "delete"] },
      content: { type: "string", description: "The whole new file content (write only)." },
    },
  },
  toolClass: "sandbox_write",
}

export const DELEGATE_WORK_TOOLS: readonly ToolDescriptor[] = [
  DELEGATE_READ_TOOL,
  DELEGATE_LIST_TOOL,
  DELEGATE_PROPOSE_PATCH_TOOL,
]

const pathArg = z.string().min(1).max(1024)

/** The arguments each delegate tool takes; a runtime validates with these too. */
export const DelegateToolArgs = {
  workspace_read: z.strictObject({ path: pathArg }),
  workspace_list: z.strictObject({ prefix: z.string().max(1024) }),
  propose_patch: z.discriminatedUnion("action", [
    z.strictObject({ path: pathArg, action: z.literal("write"), content: z.string() }),
    z.strictObject({ path: pathArg, action: z.literal("delete") }),
  ]),
} as const

export type ProposePatchArgs = z.infer<typeof DelegateToolArgs.propose_patch>

/** The runtime's context for a delegate tool call: which revision reads see, and the write scope. */
export interface DelegateToolContext extends ToolContext {
  /** Reads see this revision: the subtask's base, or the staged revision a repair continues from. */
  revision: string
  /** The paths writes may touch: the subtask's allowed paths plus approved expansions. */
  allowedPaths: readonly string[]
}

/**
 * The worker's tool runtime. A generic {@link import("./ports").ToolRuntime}
 * satisfies it; a runtime that knows the delegate context uses `revision` and
 * `allowedPaths`. `propose_patch` writes nothing to disk: the runtime
 * authorizes the path under its own rules and records the proposal, and the
 * edit takes effect only when the workflow stages the patch.
 */
export interface DelegateToolRuntime {
  describe(policyId: string): ToolDescriptor[]
  execute(intent: ToolIntent, context: DelegateToolContext): Promise<ToolReceipt>
}

// ── paths ─────────────────────────────────────────────────────────────────────

export type DelegatePathRefusal =
  "PATH_EMPTY" | "PATH_ABSOLUTE" | "PATH_TRAVERSAL" | "PATH_SENSITIVE" | "PATH_INVALID"

/** Directories a delegate never reads or writes, whatever the scope says. */
const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set([
  ".git",
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
])

/**
 * A workspace-relative path in one canonical spelling — forward slashes, no
 * `.` segments, no trailing slash — or the reason it is refused. The host
 * applies its own, stricter rules (symlinks, credential file names) on top.
 */
export function normalizeDelegatePath(
  raw: string
): { ok: true; path: string } | { ok: false; code: DelegatePathRefusal } {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { ok: false, code: "PATH_EMPTY" }
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed.charCodeAt(i) < 0x20) return { ok: false, code: "PATH_INVALID" }
  }
  const slashed = trimmed.replaceAll("\\", "/")
  if (slashed.startsWith("/") || /^[A-Za-z]:/.test(slashed) || slashed.startsWith("~")) {
    return { ok: false, code: "PATH_ABSOLUTE" }
  }
  const segments = slashed.split("/").filter((segment) => segment.length > 0 && segment !== ".")
  if (segments.length === 0) return { ok: false, code: "PATH_EMPTY" }
  if (segments.includes("..")) return { ok: false, code: "PATH_TRAVERSAL" }
  if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment.toLowerCase()))) {
    return { ok: false, code: "PATH_SENSITIVE" }
  }
  return { ok: true, path: segments.join("/") }
}

/** Whether a normalized path lies inside one of the normalized scope entries. */
export function pathInScope(path: string, scope: readonly string[]): boolean {
  return scope.some((entry) => path === entry || path.startsWith(`${entry}/`))
}

// ── patches ───────────────────────────────────────────────────────────────────

export const DELEGATE_PATCH_FORMAT = "cognia-delegate-patch-1"

export interface DelegatePatchFile {
  path: string
  action: "write" | "delete"
  /** The whole new content for a write; null for a delete. */
  content: string | null
  /** sha256 of `content`; null for a delete. */
  content_sha256: string | null
}

/** A patch: whole-file writes and deletes against one base revision, sorted by path. */
export interface DelegatePatch {
  format: typeof DELEGATE_PATCH_FORMAT
  base_revision: string
  files: DelegatePatchFile[]
}

export const DelegatePatchSchema = z.strictObject({
  format: z.literal(DELEGATE_PATCH_FORMAT),
  base_revision: z.string().min(1),
  files: z.array(
    z.strictObject({
      path: z.string().min(1),
      action: z.enum(["write", "delete"]),
      content: z.string().nullable(),
      content_sha256: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .nullable(),
    })
  ),
})

export type DelegatePatchEdit = { action: "write"; content: string } | { action: "delete" }

export function buildDelegatePatch(
  baseRevision: string,
  edits: ReadonlyMap<string, DelegatePatchEdit>
): DelegatePatch {
  const files = [...edits.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, edit]): DelegatePatchFile =>
      edit.action === "write"
        ? { path, action: "write", content: edit.content, content_sha256: sha256Hex(edit.content) }
        : { path, action: "delete", content: null, content_sha256: null }
    )
  return { format: DELEGATE_PATCH_FORMAT, base_revision: baseRevision, files }
}

/** The patch's identity: sha256 over its canonical JSON. */
export function delegatePatchSha256(patch: DelegatePatch): string {
  return canonicalHash(patch)
}

export function patchBytes(edits: ReadonlyMap<string, DelegatePatchEdit>): number {
  const encoder = new TextEncoder()
  let total = 0
  for (const edit of edits.values()) {
    if (edit.action === "write") total += encoder.encode(edit.content).byteLength
  }
  return total
}

// ── approvals (DEL-07, API-08) ────────────────────────────────────────────────

/**
 * `scope_expansion`: a write outside the subtask's allowed paths.
 * `workspace_apply`: delivering the verified patch into the user's workspace.
 */
export type DelegateApprovalKind = "scope_expansion" | "workspace_apply"

/**
 * The digest an approval is bound to: sha256 over the kind, the canonical
 * arguments and the revision. Approving one digest approves exactly that
 * operation — other arguments or another revision are a different digest.
 */
export function delegateApprovalDigest(
  kind: DelegateApprovalKind,
  args: Record<string, unknown>,
  revision: string
): string {
  return canonicalHash({ kind, args, revision })
}

export interface DelegateApprovalSummary {
  /** The paths the operation touches. */
  paths: string[]
  fileCount: number
  /** The patch being applied, for `workspace_apply`. */
  patchSha256: string | null
  patchArtifactId: string | null
}

export interface DelegateApprovalRequest {
  runId: string
  logicalStepId: string
  kind: DelegateApprovalKind
  requestDigest: string
  /** The revision the digest covers. */
  revision: string
  /** The canonical arguments the digest covers. */
  args: Record<string, unknown>
  summary: DelegateApprovalSummary
  /** Who caused the request. Never who decides it: that is only ever a person. */
  requestedBy: "worker" | "lead" | "runtime"
}

export type DelegateApprovalDecision =
  | { status: "approved"; approvalId: string; requestDigest: string }
  | { status: "denied"; approvalId: string; requestDigest: string; reason: string | null }
  /** Nobody has decided yet: the run parks as `waiting_for_approval`. */
  | { status: "waiting"; approvalId: string; requestDigest: string }

export interface ApprovalPort {
  /**
   * Idempotent per digest: asking again returns the recorded decision, so a
   * run that resumes after an approval finds it approved instead of asking
   * twice.
   */
  requestApproval(request: DelegateApprovalRequest): Promise<DelegateApprovalDecision>
}

// ── workspace ─────────────────────────────────────────────────────────────────

export type WorkspaceRefusalCode =
  | DelegatePathRefusal
  | "PATH_ESCAPE"
  | "NOT_FOUND"
  | "CONTENT_SENSITIVE"
  | "REVISION_UNKNOWN"
  | "READ_FAILED"

export type WorkspaceReadResult =
  | { ok: true; content: string; contentSha256: string; truncated: boolean }
  | { ok: false; code: WorkspaceRefusalCode; message: string }

export type WorkspaceListResult =
  | { ok: true; files: Array<{ path: string; sizeBytes: number }>; truncated: boolean }
  | { ok: false; code: WorkspaceRefusalCode; message: string }

export type StagePatchResult =
  | { ok: true; revision: string }
  | { ok: false; code: "PATCH_REFUSED" | "REVISION_UNKNOWN"; message: string; path: string | null }

export type ApplyPatchResult =
  | { ok: true; revision: string }
  /** The workspace is no longer at the patch's base: nothing was written (DEL-04). */
  | { ok: false; code: "PATCH_CONFLICT"; currentRevision: string; message: string }
  | { ok: false; code: "PATCH_REFUSED"; message: string; path: string | null }

export interface WorkspacePort {
  /** The target workspace's revision now: the base every subtask starts from. */
  currentRevision(): Promise<string>
  readFile(input: {
    path: string
    revision: string
    maxBytes: number
  }): Promise<WorkspaceReadResult>
  listFiles(input: {
    prefix: string
    revision: string
    limit: number
  }): Promise<WorkspaceListResult>
  /**
   * Materialize `patch` on its base revision in an isolated worktree — never
   * the user's checkout — and name the result. Idempotent: the same patch on
   * the same base is the same revision.
   */
  stagePatch(input: {
    runId: string
    logicalStepId: string
    patch: DelegatePatch
    signal: AbortSignal
  }): Promise<StagePatchResult>
  /**
   * Write the patch into the user's workspace if and only if the workspace is
   * still at `baseRevision`; otherwise `PATCH_CONFLICT` and nothing written.
   * Called only with an approval whose digest covers this patch.
   */
  applyPatchCAS(input: {
    runId: string
    logicalStepId: string
    patch: DelegatePatch
    baseRevision: string
    approvalId: string
    signal: AbortSignal
  }): Promise<ApplyPatchResult>
}

// ── acceptance ────────────────────────────────────────────────────────────────

export type AcceptanceRunOutcome =
  | { kind: "report"; report: VerificationReport }
  /**
   * The runtime could not run the profile at all: no sandbox tier
   * (`SANDBOX_UNAVAILABLE`), no profile (`ACCEPTANCE_PROFILE_MISSING`), or a
   * command nobody approved (`ACCEPTANCE_NOT_APPROVED`). Not a quality
   * failure: the run fails with the code, and no worker repairs it.
   */
  | { kind: "refused"; code: string; message: string }

export interface AcceptancePort {
  runProfile(input: {
    runId: string
    logicalStepId: string
    profileId: string
    /** The staged revision to verify. */
    revision: string
    signal: AbortSignal
  }): Promise<AcceptanceRunOutcome>
}

// ── the step journal (REC-06) ─────────────────────────────────────────────────

export type DelegateSideEffectKind =
  /** Pinning the workspace revision the run starts from. */
  | "base_revision"
  /**
   * Recording the tool requests of a model turn. A committed call replays its
   * text, not its tool calls, so the journal keeps them for the replay.
   */
  | "turn_intents"
  | "stage_patch"
  | "acceptance_run"
  | "workspace_apply"

/**
 * Steps whose repetition changes nothing: reading the base revision, recording
 * a turn's requests, staging a patch into an isolated worktree. A dispatched
 * one without a receipt may be dispatched again; any other is UNKNOWN and goes
 * to reconciliation.
 */
export const IDEMPOTENT_SIDE_EFFECTS: ReadonlySet<DelegateSideEffectKind> = new Set([
  "base_revision",
  "turn_intents",
  "stage_patch",
])

export type StepJournalBegin =
  | { kind: "fresh" }
  /** Committed earlier: the receipt is the step's result. */
  | { kind: "replay"; receipt: unknown }
  /** Dispatched earlier and never committed. */
  | { kind: "unknown" }
  /** The step id was recorded with a different request: the graph is not replaying itself. */
  | { kind: "mismatch" }

export interface DelegateStepJournal {
  begin(input: {
    stepId: string
    kind: DelegateSideEffectKind
    requestHash: string
  }): Promise<StepJournalBegin>
  /** Durable BEFORE the side effect starts. */
  markDispatched(stepId: string): Promise<void>
  /** Durable with the receipt (JSON-serializable). */
  commit(stepId: string, receipt: unknown): Promise<void>
}
