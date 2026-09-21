/**
 * The host's {@link WorkspacePort} for delegate (ADR-0188 B4, WP-D3).
 *
 * The delegate workflow never touches a disk. This module is the only thing
 * that does, and it answers four questions:
 *
 * - **What revision is the workspace at?** A git checkout's identity is its
 *   HEAD plus what is uncommitted: two runs must not call two different trees
 *   the same revision, or the compare-and-swap that protects the user's work
 *   (DEL-04) would compare equal on a tree that moved. A workspace that is not
 *   a git checkout gets a tree digest instead, never a constant.
 * - **What may a worker read?** A file under the path rules of
 *   `delegate-tool-policy.ts`, at a revision this run pinned, that passes the
 *   PII gate — exactly like the panel's `workspace_read` (`workspace-read.ts`),
 *   because it is the same device sending the same kind of local text to the
 *   same models. The read is served from the run's OWN SNAPSHOT of the base
 *   revision, taken once at the start: a person who keeps working during a
 *   long delegate run cannot change what the worker sees, cannot break its
 *   tool calls, and cannot have an edit of theirs swept into the patch that
 *   gets verified.
 * - **Where does a patch go?** Into the run's staging worktree, never the
 *   user's checkout. Staging is idempotent: the same patch on the same base is
 *   the same staged revision. Patches are cumulative against the base, so the
 *   staging tree is moved from one staged revision to another by returning the
 *   files the old patch touched to their base content and applying the new
 *   one — two worktrees for a whole run, not one per attempt.
 * - **How does a verified patch reach the user's workspace?** Only through
 *   `applyPatchCAS`, only with an approval the caller already obtained, and
 *   only while the workspace is still at the patch's base revision. A
 *   workspace that moved is `PATCH_CONFLICT` with nothing written — the
 *   conflict is detected before the first byte, so a refusal cannot half-apply
 *   (DEL-04). The apply itself goes through `lib/task-workspace/client.ts`, so
 *   it takes the same lease, records the same resource ledger and is undoable
 *   like every other change this app makes to a person's files.
 *
 * Every path is refused three times over (DEL-05): here, before any I/O; by
 * the host stat, which refuses a symlink rather than following it; and in Rust,
 * where `fs_read_workspace_file` / `fs_write_workspace_file` canonicalize root
 * and target and refuse a real location outside the root.
 *
 * WP-D6 is adding a Rust-side revision CAS to the task-workspace apply. Until
 * it lands, the window between the check here and the write is the size of one
 * apply call; the check is still what makes an overwrite of a moved workspace
 * impossible in every case the host can observe.
 */

import { hasNoLeakingPii } from "@cognia/redact"
import {
  sha256Hex,
  type ApplyPatchResult,
  type DelegatePatch,
  type StagePatchResult,
  type WorkspaceListResult,
  type WorkspacePort,
  type WorkspaceReadResult,
  type WorkspaceRefusalCode,
} from "@cognia/router-fusion"

import {
  DELEGATE_LIST_LIMIT,
  DELEGATE_READ_MAX_BYTES,
  delegateSymlinkRefusal,
  normalizeDelegateHostPath,
  normalizeDelegateListPrefix,
  type DelegateHostPathRefusal,
} from "./delegate-tool-policy"

/**
 * The three renderer-owned commands WP-C registered over WP-D6's crate
 * (`src-tauri/src/task_workspace.rs`). They name a path on THIS machine and
 * write the person's checkout, so they are `target: "client"`: a paired device
 * never calls them — it asks for the run's approval, and the apply happens
 * here.
 */
export const WORKSPACE_REVISION_COMMANDS = {
  /** `workspace_revision` → `wsrev1:<sha256>` plus the file count. */
  get: "task_workspace_revision_get",
  /** `apply_revision_patch` → the compare-and-swap over a `RevisionPatch`. */
  apply: "task_workspace_revision_apply",
  /**
   * `read_confined_text` (`whole` omitted: truncates and says so) and
   * `read_report_file` (`whole: true`: `too_large` instead of a truncation,
   * `missing` when the command wrote none).
   */
  read: "task_workspace_revision_read",
} as const

/** `WorkspaceRevision` on the wire. */
export interface WorkspaceRevisionAnswer {
  revision: string
  fileCount: number
}

/** `WorkspaceRefusal`: the same SCREAMING_SNAKE vocabulary as the ports. */
export interface WorkspaceRefusalAnswer {
  code: string
  path: string | null
  message: string
}

/** `RevisionApplyOutcome` on the wire. */
export interface RevisionApplyAnswer {
  status: "applied" | "conflict" | "refused"
  baseRevision: string
  /** `applied`: the revision now. `conflict`: where the workspace really is. */
  currentRevision: string | null
  written: string[]
  deleted: string[]
  refusal: WorkspaceRefusalAnswer | null
}

/** `ConfinedFileRead` on the wire. */
export interface ConfinedFileReadAnswer {
  status: "ok" | "missing" | "too_large" | "refused"
  path: string | null
  content: string | null
  contentSha256: string | null
  sizeBytes: number
  truncated: boolean
  refusal: WorkspaceRefusalAnswer | null
}

/** Files of a workspace one revision digest looks at before it reports a cap. */
export const REVISION_DIGEST_MAX_ENTRIES = 5_000
/** Dirty entries named individually in a git revision; past this, the count stands in. */
export const REVISION_DIRTY_LIMIT = 500
/**
 * Bytes of one base file the staging tree can restore. A file bigger than
 * this cannot be returned to its base content in one read, so the move is
 * refused instead of leaving a tree that is neither revision.
 */
export const STAGING_RESTORE_MAX_BYTES = 8 * 1024 * 1024
/** The marker the host's guarded read appends when it cut a file short. */
const TRUNCATION_MARKER = "\n... (truncated)"

export interface DelegateWorkspaceStat {
  exists: boolean
  isDir: boolean
  size: number
  mtimeMs: number | null
  isSymlink?: boolean
}

export interface DelegateWorkspaceListing {
  files: Array<{ path: string; sizeBytes: number; mtimeMs: number | null }>
  truncated: boolean
}

/**
 * Everything this module does outside itself. Injected so the tests drive the
 * real decisions against a fake filesystem, and dynamic in the defaults so the
 * Tauri bridges are not pulled in by anyone who supplies their own.
 */
export interface DelegateWorkspaceHost {
  /** `fs_read_workspace_file`: realpath-confined, host-capped. */
  readFile(root: string, relPath: string, maxBytes: number): Promise<string>
  writeFile(root: string, relPath: string, content: string): Promise<void>
  deleteEntry(root: string, relPath: string): Promise<void>
  stat(root: string, relPath: string): Promise<DelegateWorkspaceStat>
  list(root: string, prefix: string, limit: number): Promise<DelegateWorkspaceListing>
  /**
   * The content identity of a tree: WP-D6's `workspace_revision`
   * (`wsrev1:<sha256>` over the Git blob ids of the worktree). A host without
   * that command falls back to {@link gitWorkspaceRevision}.
   */
  revision(root: string): Promise<string>
  /** HEAD, or null when the root is not a git checkout (fallback input). */
  headRevision(root: string): Promise<string | null>
  /** Uncommitted entries, as `<status>:<staged>:<path>` (fallback input). */
  dirtyEntries(root: string): Promise<string[]>
  /**
   * Provision an isolated worktree holding the user's workspace as it is now,
   * and hand back its root. Never the user's checkout. A run provisions two:
   * the pristine `base` snapshot every read is served from, and the `staging`
   * tree every patch is materialized in.
   */
  openStaging(input: {
    runId: string
    logicalStepId: string
    workspaceRoot: string
    baseRevision: string
    purpose: "base" | "staging"
  }): Promise<{ root: string; taskRunId: string | null }>
  /** Give a provisioned worktree back at the end of the run. */
  disposeStaging(input: { taskRunId: string | null; root: string }): Promise<void>
  /**
   * Write the patch into the user's workspace, compare-and-swap on
   * `baseRevision` (WP-D6's `apply_revision_patch`): a stale base is
   * `conflict` with zero writes. Called only after the caller checked the CAS
   * itself and holds an approval for this exact patch.
   */
  applyPatch(input: {
    workspaceRoot: string
    stagedRoot: string
    taskRunId: string | null
    patch: DelegatePatch
    baseRevision: string
    approvalId: string
  }): Promise<{
    status: "applied" | "conflict" | "refused"
    currentRevision?: string
    refusal?: string
    path?: string | null
  }>
}

export interface DelegateWorkspacePortInput {
  runId: string
  /** The user's checkout. Reads at the base revision and the apply target. */
  workspaceRoot: string
  host?: Partial<DelegateWorkspaceHost>
  /** Bytes of one file a read returns. */
  readMaxBytes?: number
  listLimit?: number
  /** Bytes of one base file the staging tree may restore. */
  restoreMaxBytes?: number
}

/** A revision this run staged, and the patch that produces it from the base. */
export interface StagedRevision {
  revision: string
  patchSha256: string
  baseRevision: string
  patch: DelegatePatch
}

export interface DelegateWorkspacePort extends WorkspacePort {
  /** The revisions this run staged, oldest first. Read by the delegate UI. */
  readonly staged: readonly StagedRevision[]
  /**
   * The worktree holding `revision`, materializing it in the staging tree when
   * it is not the one currently there. Null for a revision this run does not
   * know, and for the base before the run snapshotted it.
   */
  rootForRevision(revision: string): Promise<string | null>
  /** Give both worktrees back. Called once, when the run reaches a terminal state. */
  dispose(): Promise<void>
}

const REFUSAL_MESSAGES: Record<DelegateHostPathRefusal, string> = {
  PATH_EMPTY: "the path is empty",
  PATH_ABSOLUTE: "an absolute path is refused; name a path relative to the workspace root",
  PATH_TRAVERSAL: "a path that leaves the workspace is refused",
  PATH_SENSITIVE: "a credential-shaped path is refused",
  PATH_INVALID: "the path is not a usable workspace path",
  PATH_HOST_SURFACE: "a host device, socket or process path is refused",
  PATH_SYMLINK: "a symbolic link is refused rather than followed",
}

/**
 * The host's refusal in the contract's vocabulary. A symlink is an escape;
 * a host device or socket is as sensitive as a credential. The precise reason
 * stays in the message, which is what a person reads.
 */
function refusalOf(code: DelegateHostPathRefusal): { code: WorkspaceRefusalCode; message: string } {
  const mapped: WorkspaceRefusalCode =
    code === "PATH_SYMLINK" ? "PATH_ESCAPE" : code === "PATH_HOST_SURFACE" ? "PATH_SENSITIVE" : code
  return { code: mapped, message: `refused: ${code} — ${REFUSAL_MESSAGES[code]}` }
}

/** "Escapes workspace" from the Rust guard, whatever wording it arrives in. */
function isEscapeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /escapes workspace|outside (the )?(workspace|root)|path escape/i.test(message)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The identity of a workspace's content: `git:<head>` for a clean checkout,
 * `git:<head>+<digest>` when something is uncommitted, and `tree:<digest>`
 * when the root is not a git checkout at all. Never a constant, and never
 * HEAD alone — a dirty tree that reported its HEAD would let a patch built on
 * one tree apply onto another.
 */
export async function gitWorkspaceRevision(
  root: string,
  host: Pick<DelegateWorkspaceHost, "headRevision" | "dirtyEntries" | "stat" | "list">
): Promise<string> {
  const head = await host.headRevision(root)
  if (head) {
    const dirty = await host.dirtyEntries(root)
    if (dirty.length === 0) return `git:${head}`
    const named = [...dirty].sort().slice(0, REVISION_DIRTY_LIMIT)
    const stats = await Promise.all(
      named.map(async (entry) => {
        const path = entry.slice(entry.indexOf(":", entry.indexOf(":") + 1) + 1)
        // Size and mtime are what distinguishes two edits of one already-dirty
        // file: its git status letter does not change between them.
        const stat = await host.stat(root, path).catch(() => null)
        return `${entry}|${stat?.size ?? -1}|${stat?.mtimeMs ?? -1}`
      })
    )
    return `git:${head}+${sha256Hex(`${dirty.length}\n${stats.join("\n")}`).slice(0, 32)}`
  }
  const listing = await host.list(root, "", REVISION_DIGEST_MAX_ENTRIES)
  const lines = listing.files
    .map((file) => `${file.path}|${file.sizeBytes}|${file.mtimeMs ?? -1}`)
    .sort()
  return `tree:${sha256Hex(`${listing.truncated ? "truncated" : "complete"}\n${lines.join("\n")}`).slice(0, 32)}`
}

/** The identity of a tree, through the host (WP-D6) or the git fallback. */
export async function workspaceRevision(
  root: string,
  host: DelegateWorkspaceHost
): Promise<string> {
  return host.revision(root)
}

/** The revision a staged patch produces. Deterministic: same base, same patch, same name. */
export function stagedRevisionId(baseRevision: string, patchSha256: string): string {
  return `staged:${sha256Hex(`${baseRevision}\u0000${patchSha256}`).slice(0, 32)}`
}

function patchSha(patch: DelegatePatch): string {
  return sha256Hex(JSON.stringify(patch))
}

export function defaultDelegateWorkspaceHost(): DelegateWorkspaceHost {
  return {
    readFile: async (root, relPath, maxBytes) => {
      // WP-D6's confined text read, so what a read covers and what a revision
      // covers are the same rules (`.git` and `node_modules` are neither).
      try {
        const { transport } = await import("@/lib/tauri")
        const answer = await transport.call<ConfinedFileReadAnswer>(
          WORKSPACE_REVISION_COMMANDS.read,
          { root, relPath, maxBytes }
        )
        if (answer.status === "ok") {
          return answer.truncated
            ? `${answer.content ?? ""}${TRUNCATION_MARKER}`
            : (answer.content ?? "")
        }
        if (answer.status === "missing") throw new Error(`read ${relPath}: no such file`)
        throw new Error(answer.refusal?.message ?? `read ${relPath}: ${answer.status}`)
      } catch (error) {
        if (!isUnknownCommand(error)) throw error
      }
      const { readWorkspaceFile } = await import("@/lib/files/workspace-fs")
      return readWorkspaceFile(root, relPath, maxBytes)
    },
    writeFile: async (root, relPath, content) => {
      const { writeWorkspaceFile } = await import("@/lib/files/workspace-fs")
      await writeWorkspaceFile(root, relPath, content)
    },
    deleteEntry: async (root, relPath) => {
      const { deleteWorkspaceEntry } = await import("@/lib/files/workspace-fs")
      await deleteWorkspaceEntry(root, relPath, false)
    },
    stat: async (root, relPath) => {
      const { statWorkspaceFile } = await import("@/lib/files/workspace-fs")
      const stat = await statWorkspaceFile(root, relPath)
      return {
        exists: stat.exists,
        isDir: stat.isDir,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ...(stat.isSymlink === undefined ? {} : { isSymlink: stat.isSymlink }),
      }
    },
    list: async (root, prefix, limit) => {
      const { walkWorkspace } = await import("@/lib/files/workspace-fs")
      const walk = await walkWorkspace(root, {
        ...(prefix ? { relPath: prefix } : {}),
        maxEntries: limit + 1,
      })
      const files = walk.entries
        .filter((entry) => !entry.isDir)
        .map((entry) => ({
          path: entry.relPath,
          sizeBytes: entry.size,
          mtimeMs: entry.mtimeMs,
        }))
      return { files: files.slice(0, limit), truncated: walk.truncated || files.length > limit }
    },
    revision: async (root) => {
      // WP-D6's snapshot digest over the worktree's Git blob ids: a no-op
      // commit does not move it, and an uncommitted edit does.
      try {
        const { transport } = await import("@/lib/tauri")
        const answer = await transport.call<WorkspaceRevisionAnswer>(
          WORKSPACE_REVISION_COMMANDS.get,
          { root }
        )
        if (answer?.revision) return answer.revision
      } catch {
        // No such command on this host (the CLI's stdio transport, an older
        // desktop): fall back to the git computation rather than inventing a
        // constant. A host with no local workspace at all fails below.
      }
      try {
        return await gitWorkspaceRevision(root, defaultDelegateWorkspaceHost())
      } catch (error) {
        throw new Error(
          `this host cannot read a local workspace revision, so a delegate run has no base to work from: ${messageOf(error)}`
        )
      }
    },
    headRevision: async (root) => {
      const { gitIsRepo, gitLog } = await import("@/lib/git/commands")
      if (!(await gitIsRepo(root).catch(() => false))) return null
      const head = await gitLog(root, 1, 0).catch(() => [])
      return head[0]?.hash?.trim() || null
    },
    dirtyEntries: async (root) => {
      const { gitStatus } = await import("@/lib/git/commands")
      const status = await gitStatus(root)
      return [...status.staged, ...status.changes, ...status.merge].map(
        (change) => `${change.status}:${change.staged ? 1 : 0}:${change.path}`
      )
    },
    openStaging: async (input) => {
      const { beginTaskWorkspaceTurn, runIdForTurn, taskIdForMessage } =
        await import("@/lib/task-workspace/client")
      const taskId = taskIdForMessage(`fusion-delegate-${input.runId}`)
      const run = await beginTaskWorkspaceTurn({
        taskId,
        sessionId: `fusion:${input.runId}`,
        // Two worktrees per run, and the same ids on a replay: the pristine
        // base snapshot, and the tree patches are materialized in.
        runId: runIdForTurn(`fusion:${input.runId}:${input.purpose}`, 1),
        agentId: input.runId,
        agentKind: "router-fusion-delegate",
        workspaceRoot: input.workspaceRoot,
        base: { kind: "workingState" },
        surface: "router-fusion-delegate",
      })
      if (!run) {
        throw new Error("the host would not provision an isolated worktree for this run")
      }
      return { root: run.executionRoot, taskRunId: run.runId }
    },
    disposeStaging: async ({ taskRunId }) => {
      if (!taskRunId) return
      const { settleTaskWorkspaceRun } = await import("@/lib/task-workspace/client")
      // `cancelled`: the run is over and nothing here is being adopted, so the
      // lease is released and the worktree goes to the lifecycle policy.
      await settleTaskWorkspaceRun(taskRunId, "cancelled").catch(() => undefined)
    },
    applyPatch: async ({ workspaceRoot, stagedRoot, taskRunId, patch, baseRevision }) => {
      // WP-D6's compare-and-swap: validate, confine, capture the revision,
      // compare, byte-check, stage to sibling temps, publish by rename. A
      // stale base writes nothing at all.
      try {
        const { transport } = await import("@/lib/tauri")
        // `patch` travels verbatim: `RevisionPatch` is byte-identical to the
        // package's `DelegatePatch`, and the struct denies unknown fields.
        const answer = await transport.call<RevisionApplyAnswer>(
          WORKSPACE_REVISION_COMMANDS.apply,
          { root: workspaceRoot, patch }
        )
        return {
          status: answer.status,
          ...(answer.currentRevision ? { currentRevision: answer.currentRevision } : {}),
          ...(answer.refusal
            ? {
                refusal: `${answer.refusal.code}: ${answer.refusal.message}`,
                path: answer.refusal.path,
              }
            : {}),
        }
      } catch (error) {
        if (!isUnknownCommand(error)) {
          return { status: "refused", refusal: messageOf(error) }
        }
      }
      if (taskRunId) {
        // The task-workspace turn that staged the tree owns the adoption path,
        // with its lease, its resource ledger and its undo.
        const { settleTaskWorkspaceRun, applyTaskWorkspace } =
          await import("@/lib/task-workspace/client")
        await settleTaskWorkspaceRun(taskRunId, "ready").catch(() => undefined)
        const outcome = await applyTaskWorkspace(taskRunId, [], false)
        return outcome.state === "applied"
          ? { status: "applied" }
          : { status: "refused", refusal: `the host did not apply the change (${outcome.state})` }
      }
      // No task run and no host command (a managed workspace, a test host):
      // the patch carries whole-file contents, so write them through the
      // guarded bridge. `baseRevision` was compared by the caller.
      void baseRevision
      void stagedRoot
      const { writeWorkspaceFile, deleteWorkspaceEntry } = await import("@/lib/files/workspace-fs")
      for (const file of patch.files) {
        if (file.action === "delete") await deleteWorkspaceEntry(workspaceRoot, file.path, false)
        else await writeWorkspaceFile(workspaceRoot, file.path, file.content ?? "")
      }
      return { status: "applied" }
    },
  }
}

/** A host that does not carry the command at all, as opposed to one that refused. */
function isUnknownCommand(error: unknown): boolean {
  return /unknown command|not implemented|tauri-only|unsupported command|not authorized/i.test(
    messageOf(error)
  )
}

/**
 * The host WorkspacePort for one delegate run.
 *
 * `workspaceRoot` is the user's checkout: it is read at the base revision and
 * it is the apply target, and it is never written except by `applyPatchCAS`.
 */
export function createDelegateWorkspacePort(
  input: DelegateWorkspacePortInput
): DelegateWorkspacePort {
  const host: DelegateWorkspaceHost = { ...defaultDelegateWorkspaceHost(), ...input.host }
  const readMaxBytes = input.readMaxBytes ?? DELEGATE_READ_MAX_BYTES
  const restoreMaxBytes = input.restoreMaxBytes ?? STAGING_RESTORE_MAX_BYTES
  const listLimit = input.listLimit ?? DELEGATE_LIST_LIMIT
  const staged: StagedRevision[] = []
  /** The workspace revision this run pinned, set by the first `currentRevision`. */
  let baseRevision: string | null = null
  /** The two worktrees of this run: pristine base, and the tree patches live in. */
  let trees: {
    base: { root: string; taskRunId: string | null }
    staging: { root: string; taskRunId: string | null }
  } | null = null
  /** Which revision the staging tree currently holds. */
  let stagingRevision: string | null = null

  type RootResult =
    { ok: true; root: string } | { ok: false; code: WorkspaceRefusalCode; message: string }

  /**
   * The run's two isolated worktrees, provisioned once from the user's
   * checkout while it is still at the base revision.
   *
   * This is what makes the run immune to a person who keeps working: every
   * read and every staged tree comes from the snapshot, so an edit made
   * during the run cannot change what the worker sees, and cannot smuggle
   * itself into the patch that is verified. The checkout is read once, here.
   * The revision is re-checked after both are provisioned, because the two
   * are captured one after the other and a tree pair captured at different
   * states would corrupt every later restore.
   */
  const ensureTrees = async (): Promise<RootResult> => {
    if (trees) return { ok: true, root: trees.base.root }
    if (baseRevision === null) {
      return { ok: false, code: "REVISION_UNKNOWN", message: "the run has pinned no base revision" }
    }
    const pinned = baseRevision
    let before: string
    try {
      before = await host.revision(input.workspaceRoot)
    } catch (error) {
      return { ok: false, code: "READ_FAILED", message: messageOf(error) }
    }
    if (before !== pinned) {
      return {
        ok: false,
        code: "REVISION_UNKNOWN",
        message: `the workspace moved to ${before} before the run could snapshot ${pinned}`,
      }
    }
    let base: { root: string; taskRunId: string | null }
    let staging: { root: string; taskRunId: string | null }
    try {
      const open = (purpose: "base" | "staging") =>
        host.openStaging({
          runId: input.runId,
          logicalStepId: `delegate:snapshot:${purpose}`,
          workspaceRoot: input.workspaceRoot,
          baseRevision: pinned,
          purpose,
        })
      base = await open("base")
      staging = await open("staging")
    } catch (error) {
      return {
        ok: false,
        code: "READ_FAILED",
        message: `no isolated worktree could be provisioned: ${messageOf(error)}`,
      }
    }
    const after = await host.revision(input.workspaceRoot).catch(() => pinned)
    if (after !== pinned) {
      await host.disposeStaging(base).catch(() => undefined)
      await host.disposeStaging(staging).catch(() => undefined)
      return {
        ok: false,
        code: "REVISION_UNKNOWN",
        message: `the workspace moved to ${after} while the run was snapshotting ${pinned}`,
      }
    }
    trees = { base, staging }
    stagingRevision = pinned
    return { ok: true, root: base.root }
  }

  /** The files a patch touches, as a set of normalized paths. */
  const touchedBy = (patch: DelegatePatch | null): string[] =>
    patch ? patch.files.map((file) => file.path) : []

  /**
   * Move the staging tree to `revision`: return every file the tree's current
   * patch touched to its base content, then apply the target patch. Every
   * patch is cumulative against the run's base, so this is exact — and a base
   * file the host cannot hand back in full (too large, not text) refuses the
   * move rather than leaving a half-restored tree.
   */
  const materialize = async (target: StagedRevision): Promise<RootResult> => {
    const ready = await ensureTrees()
    if (!ready.ok) return ready
    const { base, staging } = trees as NonNullable<typeof trees>
    if (stagingRevision === target.revision) return { ok: true, root: staging.root }
    const current = staged.find((entry) => entry.revision === stagingRevision)
    const restore = [...new Set([...touchedBy(current?.patch ?? null), ...touchedBy(target.patch)])]
    // A partially moved tree must never be read as a revision: the marker is
    // cleared first and set again only once the move completed.
    stagingRevision = null
    for (const path of restore) {
      let content: string | null
      try {
        content = await host.readFile(base.root, path, restoreMaxBytes)
      } catch {
        content = null
      }
      if (content === null) {
        const stat = await host.stat(base.root, path).catch(() => null)
        if (stat?.exists) {
          return {
            ok: false,
            code: "READ_FAILED",
            message: `${path} could not be returned to its base content`,
          }
        }
        await host.deleteEntry(staging.root, path).catch(() => undefined)
        continue
      }
      if (content.endsWith(TRUNCATION_MARKER)) {
        return {
          ok: false,
          code: "READ_FAILED",
          message: `${path} is larger than the staging restore cap`,
        }
      }
      await host.writeFile(staging.root, path, content)
    }
    for (const file of target.patch.files) {
      if (file.action === "write") await host.writeFile(staging.root, file.path, file.content ?? "")
      else await host.deleteEntry(staging.root, file.path).catch(() => undefined)
    }
    stagingRevision = target.revision
    return { ok: true, root: staging.root }
  }

  /**
   * The root to read `revision` from. The base is the pristine snapshot, a
   * staged revision is the staging tree moved to it; a revision this run
   * never produced is unknown, whatever the checkout looks like now.
   */
  const resolveReadRoot = async (revision: string): Promise<RootResult> => {
    if (baseRevision !== null && revision === baseRevision) return ensureTrees()
    const target = staged.find((entry) => entry.revision === revision)
    if (target) return materialize(target)
    return {
      ok: false,
      code: "REVISION_UNKNOWN",
      message: `this run knows no revision ${revision}`,
    }
  }

  const readAt = async (
    root: string,
    path: string,
    maxBytes: number
  ): Promise<WorkspaceReadResult> => {
    const stat = await host.stat(root, path).catch(() => null)
    if (stat) {
      const symlink = delegateSymlinkRefusal(stat)
      if (symlink) return { ok: false, ...refusalOf(symlink) }
      if (!stat.exists) return { ok: false, code: "NOT_FOUND", message: path }
      if (stat.isDir) return { ok: false, code: "NOT_FOUND", message: `${path} is a directory` }
    }
    let content: string
    try {
      content = await host.readFile(root, path, maxBytes)
    } catch (error) {
      return isEscapeError(error)
        ? { ok: false, ...refusalOf("PATH_TRAVERSAL") }
        : { ok: false, code: "READ_FAILED", message: "the file could not be read" }
    }
    // Local text on its way to a model: the same gate every such path passes,
    // before the content is hashed, stored or shown.
    if (!hasNoLeakingPii(content)) {
      return { ok: false, code: "CONTENT_SENSITIVE", message: "refused: CONTENT_SENSITIVE" }
    }
    const bytes = new TextEncoder().encode(content).byteLength
    return {
      ok: true,
      content,
      contentSha256: sha256Hex(content),
      truncated: bytes >= maxBytes || content.endsWith(TRUNCATION_MARKER),
    }
  }

  /** Every reason the host will not write this patch, checked before anything is written. */
  const patchRefusal = async (
    patch: DelegatePatch,
    root: string
  ): Promise<{ message: string; path: string } | null> => {
    const seen = new Set<string>()
    for (const file of patch.files) {
      const normalized = normalizeDelegateHostPath(file.path)
      if (!normalized.ok) {
        return { message: refusalOf(normalized.code).message, path: file.path }
      }
      if (normalized.path !== file.path) {
        return {
          message: "the patch names a path in a spelling the host does not accept",
          path: file.path,
        }
      }
      if (seen.has(normalized.path)) {
        return { message: "the patch names the same file twice", path: file.path }
      }
      seen.add(normalized.path)
      if (file.action === "write") {
        if (file.content === null || sha256Hex(file.content) !== file.content_sha256) {
          return { message: "the file's content does not match its hash", path: file.path }
        }
      } else if (file.content !== null || file.content_sha256 !== null) {
        return { message: "a delete carries content", path: file.path }
      }
      const stat = await host.stat(root, normalized.path).catch(() => null)
      if (stat) {
        const symlink = delegateSymlinkRefusal(stat)
        if (symlink) return { message: refusalOf(symlink).message, path: file.path }
        if (stat.exists && stat.isDir) {
          return { message: "the path is a directory", path: file.path }
        }
      }
    }
    return null
  }

  return {
    get staged() {
      return staged
    },

    async rootForRevision(revision: string): Promise<string | null> {
      const root = await resolveReadRoot(revision)
      return root.ok ? root.root : null
    },

    async dispose(): Promise<void> {
      const open = trees
      trees = null
      stagingRevision = null
      if (!open) return
      await host.disposeStaging(open.staging).catch(() => undefined)
      await host.disposeStaging(open.base).catch(() => undefined)
    },

    async currentRevision(): Promise<string> {
      const revision = await host.revision(input.workspaceRoot)
      baseRevision ??= revision
      return revision
    },

    async readFile(request): Promise<WorkspaceReadResult> {
      const normalized = normalizeDelegateHostPath(request.path)
      if (!normalized.ok) return { ok: false, ...refusalOf(normalized.code) }
      const root = await resolveReadRoot(request.revision)
      if (!root.ok) return { ok: false, code: root.code, message: root.message }
      return readAt(root.root, normalized.path, Math.min(request.maxBytes, readMaxBytes))
    },

    async listFiles(request): Promise<WorkspaceListResult> {
      const prefix = normalizeDelegateListPrefix(request.prefix)
      if (!prefix.ok) return { ok: false, ...refusalOf(prefix.code) }
      const root = await resolveReadRoot(request.revision)
      if (!root.ok) return { ok: false, code: root.code, message: root.message }
      const limit = Math.min(request.limit, listLimit)
      let listing: DelegateWorkspaceListing
      try {
        listing = await host.list(root.root, prefix.path, limit)
      } catch (error) {
        return isEscapeError(error)
          ? { ok: false, ...refusalOf("PATH_TRAVERSAL") }
          : { ok: false, code: "READ_FAILED", message: "the workspace could not be listed" }
      }
      // A listing is shown to a model, so it is filtered by the same rules a
      // read is: a credential file is not named, let alone opened.
      const files = listing.files
        .filter((file) => normalizeDelegateHostPath(file.path).ok)
        .map((file) => ({ path: file.path, sizeBytes: file.sizeBytes }))
      return {
        ok: true,
        files,
        truncated: listing.truncated || files.length < listing.files.length,
      }
    },

    async stagePatch(request): Promise<StagePatchResult> {
      const sha = patchSha(request.patch)
      const revision = stagedRevisionId(request.patch.base_revision, sha)
      const existing = staged.find((entry) => entry.revision === revision)
      // The same patch on the same base is the same revision: a replayed step
      // returns it, and the tree is only moved when something reads it.
      if (existing) return { ok: true, revision }
      if (baseRevision === null || request.patch.base_revision !== baseRevision) {
        return {
          ok: false,
          code: "REVISION_UNKNOWN",
          message: `this run is based on ${baseRevision ?? "nothing yet"}, not ${request.patch.base_revision}`,
          path: null,
        }
      }
      if (request.signal.aborted) {
        return { ok: false, code: "PATCH_REFUSED", message: "the run was cancelled", path: null }
      }
      const ready = await ensureTrees()
      if (!ready.ok) {
        return { ok: false, code: "PATCH_REFUSED", message: ready.message, path: null }
      }
      const refused = await patchRefusal(
        request.patch,
        (trees as NonNullable<typeof trees>).base.root
      )
      if (refused) {
        return { ok: false, code: "PATCH_REFUSED", message: refused.message, path: refused.path }
      }
      const entry: StagedRevision = {
        revision,
        patchSha256: sha,
        baseRevision: request.patch.base_revision,
        patch: request.patch,
      }
      // Materializing it now is the staging: a refusal here has left the tree
      // at no revision, and nothing reads it until a later move succeeds.
      const written = await materialize(entry)
      if (!written.ok) {
        return { ok: false, code: "PATCH_REFUSED", message: written.message, path: null }
      }
      staged.push(entry)
      return { ok: true, revision }
    },

    async applyPatchCAS(request): Promise<ApplyPatchResult> {
      const sha = patchSha(request.patch)
      if (request.patch.base_revision !== request.baseRevision) {
        // Not a conflict: the caller asked to apply a patch built on another
        // base. Nothing is written either way.
        return {
          ok: false,
          code: "PATCH_REFUSED",
          message: `the patch is based on ${request.patch.base_revision}, not ${request.baseRevision}`,
          path: null,
        }
      }
      let current: string
      try {
        current = await host.revision(input.workspaceRoot)
      } catch (error) {
        return {
          ok: false,
          code: "PATCH_REFUSED",
          message: `the workspace revision could not be read: ${messageOf(error)}`,
          path: null,
        }
      }
      // DEL-04: the compare half of the compare-and-swap. Nothing below this
      // line has written a byte, so a conflict leaves the workspace untouched.
      // The host's `apply_revision_patch` compares again under its own lock.
      if (current !== request.baseRevision) {
        return {
          ok: false,
          code: "PATCH_CONFLICT",
          currentRevision: current,
          message: `the workspace is at ${current}, not at the patch's base ${request.baseRevision}`,
        }
      }
      const refused = await patchRefusal(request.patch, input.workspaceRoot)
      if (refused) {
        return { ok: false, code: "PATCH_REFUSED", message: refused.message, path: refused.path }
      }
      if (request.signal.aborted) {
        return { ok: false, code: "PATCH_REFUSED", message: "the run was cancelled", path: null }
      }
      let outcome: Awaited<ReturnType<DelegateWorkspaceHost["applyPatch"]>>
      try {
        outcome = await host.applyPatch({
          workspaceRoot: input.workspaceRoot,
          stagedRoot: trees?.staging.root ?? input.workspaceRoot,
          taskRunId: trees?.staging.taskRunId ?? null,
          patch: request.patch,
          baseRevision: request.baseRevision,
          approvalId: request.approvalId,
        })
      } catch (error) {
        return {
          ok: false,
          code: "PATCH_REFUSED",
          message: `the workspace refused the change: ${messageOf(error)}`,
          path: null,
        }
      }
      if (outcome.status === "conflict") {
        return {
          ok: false,
          code: "PATCH_CONFLICT",
          currentRevision: outcome.currentRevision ?? current,
          message: `the workspace moved to ${outcome.currentRevision ?? "another revision"} before the patch could be applied`,
        }
      }
      if (outcome.status === "refused") {
        return {
          ok: false,
          code: "PATCH_REFUSED",
          message: outcome.refusal ?? "the workspace refused the change",
          path: outcome.path ?? null,
        }
      }
      const applied =
        outcome.currentRevision ?? (await host.revision(input.workspaceRoot).catch(() => null))
      return { ok: true, revision: applied ?? `applied:${sha.slice(0, 32)}` }
    },
  }
}
