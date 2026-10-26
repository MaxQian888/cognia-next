/**
 * A working directory of its own for every rollout (ADR-0237).
 *
 * Probes must never touch the user's real workspace, and two rollouts must
 * never see each other's files. Three isolation kinds:
 *
 * - `none`  no working directory: the run is text-only.
 * - `files` a scratch directory under AppData with a fresh copy of the task's
 *           input files. Deliverables are the files the run created or changed.
 * - `git`   a managed task-workspace bundle at the run's frozen base commit, the
 *           same isolation Best-of-N candidates get. Deliverables are the files
 *           the turn changed; acceptance profiles run against a captured
 *           changeset, exactly as an SCM review does.
 *
 * A git worktree is not a sandbox: the probe policy, the per-run capability
 * grant and workspace confinement are what keep a probe inside its directory.
 * Isolation only guarantees it starts from known content and leaves the user's
 * checkout alone.
 */

import type { Project } from "@/types"
import type {
  HarnessDeliverable,
  HarnessEvolutionTask,
  HarnessTaskInputFile,
} from "@/types/harness/evolution"
import type { AcceptanceCheckOutcome } from "../checks"
import { DELIVERABLE_TEXT_MAX_CHARS } from "../evidence"

/** Files read back per rollout; more than this and the rest are listed by size only. */
export const MAX_DELIVERABLE_FILES = 200
/** Bytes read per deliverable. */
export const MAX_DELIVERABLE_READ_BYTES = 256 * 1024
const MARKER_FILE = ".cognia-harness-probe"

export interface RolloutWorkspace {
  kind: HarnessEvolutionTask["isolation"]
  /** Working directory of the run; absent for `none`. */
  root?: string
  /** A project rooted at `root`, so the resolver confines the run to it. */
  project?: Project
  /** Read back what the run produced. */
  collect(): Promise<{ deliverables: HarnessDeliverable[]; filesObservable: boolean }>
  /** Run acceptance profiles against what the run produced (git only). */
  acceptance?(
    profileIds: readonly string[],
    signal: AbortSignal
  ): Promise<Map<string, AcceptanceCheckOutcome>>
  /** Remove the workspace. Idempotent. */
  release(finalState: "ready" | "failed" | "cancelled"): Promise<void>
}

export interface WalkedFile {
  relPath: string
  size: number
}

export interface IsolationFsDeps {
  /** Read a host file as base64. `root` is its directory. */
  readHostFileBase64(root: string, relPath: string): Promise<string>
  /** Write bytes under AppData; returns the absolute path. Creates directories. */
  writeAppDataFile(relativePath: string, bytes: Uint8Array): Promise<string>
  appDataPath(relativePath: string): Promise<string>
  removeAppDataDirectory(relativePath: string): Promise<void>
  walk(root: string): Promise<{ files: WalkedFile[]; truncated: boolean }>
  readText(
    root: string,
    relPath: string,
    maxBytes: number
  ): Promise<{ content: string; sha256: string; size: number }>
}

export interface GitWorkspaceHandle {
  root: string
  workspaceId: string
  /** Settle the turn and return the paths it changed (repo-relative). */
  settle(finalState: "ready" | "failed" | "cancelled"): Promise<string[]>
  acceptance?(
    profileIds: readonly string[],
    signal: AbortSignal
  ): Promise<Map<string, AcceptanceCheckOutcome>>
  archive(): Promise<void>
}

export interface IsolationGitDeps {
  acquire(input: {
    task: HarnessEvolutionTask
    sessionId: string
    characterId: string
    runId: string
    label: string
  }): Promise<GitWorkspaceHandle>
}

export interface IsolationDeps {
  fs: IsolationFsDeps
  git: IsolationGitDeps
  now(): number
}

export function probeDirectory(runId: string, label: string): string {
  const safe = label.replace(/[^A-Za-z0-9_-]/g, "_")
  return `harness-evolution/${runId}/${safe}`
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

/** A host path as its directory and file name (either separator). */
export function splitPath(path: string): { dir: string; name: string } {
  const normalized = path.replace(/\\/g, "/")
  const i = normalized.lastIndexOf("/")
  return i < 0
    ? { dir: ".", name: normalized }
    : { dir: normalized.slice(0, i) || "/", name: normalized.slice(i + 1) }
}

/** A project rooted at one directory, so the resolver confines a run to it. */
export function syntheticProject(id: string, name: string, root: string, now: number): Project {
  const at = new Date(now)
  return {
    id,
    name,
    roots: [{ id: `${id}:root`, path: root, isPrimary: true }],
    knowledgeBase: [],
    sessionIds: [],
    sessionCount: 0,
    messageCount: 0,
    createdAt: at,
    updatedAt: at,
    lastAccessedAt: at,
  } as unknown as Project
}

export class InputFileChangedError extends Error {
  constructor(readonly file: HarnessTaskInputFile) {
    super(`Input file ${file.relativePath} changed since the task was created; start a new run.`)
    this.name = "InputFileChangedError"
  }
}

async function readDeliverables(
  fs: IsolationFsDeps,
  root: string,
  paths: readonly { relPath: string; size: number }[],
  unchanged: (relPath: string, sha256: string) => boolean
): Promise<HarnessDeliverable[]> {
  const out: HarnessDeliverable[] = []
  for (const file of paths.slice(0, MAX_DELIVERABLE_FILES)) {
    if (file.relPath === MARKER_FILE) continue
    try {
      const read = await fs.readText(root, file.relPath, MAX_DELIVERABLE_READ_BYTES)
      if (unchanged(file.relPath, read.sha256)) continue
      const truncated =
        read.size > MAX_DELIVERABLE_READ_BYTES || read.content.length > DELIVERABLE_TEXT_MAX_CHARS
      out.push({
        path: file.relPath,
        text: read.content.slice(0, DELIVERABLE_TEXT_MAX_CHARS),
        bytes: read.size,
        sha256: read.sha256,
        ...(truncated ? { truncated: true } : {}),
      })
    } catch {
      // Not decodable as text (or vanished): keep its size so a check can still see it exists.
      out.push({ path: file.relPath, bytes: file.size })
    }
  }
  for (const file of paths.slice(MAX_DELIVERABLE_FILES)) {
    out.push({ path: file.relPath, bytes: file.size, truncated: true })
  }
  return out
}

/** Prepare the working directory one rollout runs in. */
export async function prepareRolloutWorkspace(
  task: HarnessEvolutionTask,
  ids: { runId: string; label: string; sessionId: string; characterId: string },
  deps: IsolationDeps
): Promise<RolloutWorkspace> {
  if (task.isolation === "none") {
    return {
      kind: "none",
      collect: async () => ({ deliverables: [], filesObservable: false }),
      release: async () => {},
    }
  }

  if (task.isolation === "git") {
    const handle = await deps.git.acquire({ task, ...ids })
    let changed: string[] | null = null
    let released = false
    const settle = async (state: "ready" | "failed" | "cancelled") => {
      if (changed === null) changed = await handle.settle(state)
      return changed
    }
    return {
      kind: "git",
      root: handle.root,
      project: syntheticProject(
        `harness-probe:${ids.runId}:${ids.label}`,
        task.title,
        handle.root,
        deps.now()
      ),
      async collect() {
        const paths = await settle("ready")
        const sizes = await deps.fs.walk(handle.root).catch(() => ({ files: [], truncated: false }))
        const sizeOf = new Map(sizes.files.map((f) => [f.relPath, f.size]))
        const files = paths.map((p) => ({ relPath: p, size: sizeOf.get(p) ?? 0 }))
        return {
          deliverables: await readDeliverables(deps.fs, handle.root, files, () => false),
          filesObservable: true,
        }
      },
      ...(handle.acceptance
        ? { acceptance: (profileIds, signal) => handle.acceptance!(profileIds, signal) }
        : {}),
      async release(finalState) {
        if (released) return
        released = true
        try {
          await settle(finalState)
        } finally {
          await handle.archive()
        }
      },
    }
  }

  // files: a scratch copy of the inputs.
  const dir = probeDirectory(ids.runId, ids.label)
  const work = `${dir}/work`
  const inputHashes = new Map<string, string>()
  await deps.fs.writeAppDataFile(`${work}/${MARKER_FILE}`, new TextEncoder().encode(ids.runId))
  for (const file of task.inputFiles ?? []) {
    const { dir: srcDir, name } = splitPath(file.sourcePath)
    const bytes = base64ToBytes(await deps.fs.readHostFileBase64(srcDir, name))
    const sha = await sha256OfBytes(bytes)
    if (file.sha256 && file.sha256 !== sha) throw new InputFileChangedError(file)
    await deps.fs.writeAppDataFile(`${work}/${file.relativePath}`, bytes)
    inputHashes.set(file.relativePath, sha)
  }
  const root = await deps.fs.appDataPath(work)
  let released = false
  return {
    kind: "files",
    root,
    project: syntheticProject(
      `harness-probe:${ids.runId}:${ids.label}`,
      task.title,
      root,
      deps.now()
    ),
    async collect() {
      const walked = await deps.fs.walk(root)
      return {
        deliverables: await readDeliverables(
          deps.fs,
          root,
          walked.files,
          (relPath, sha) => inputHashes.get(relPath) === sha
        ),
        filesObservable: true,
      }
    },
    async release() {
      if (released) return
      released = true
      await deps.fs.removeAppDataDirectory(dir)
    },
  }
}

/** Production dependencies. */
export async function defaultIsolationDeps(): Promise<IsolationDeps> {
  const [workspaceFs, appData] = await Promise.all([
    import("@/lib/files/workspace-fs"),
    import("@/lib/tauri/app-data-files"),
  ])
  return {
    fs: {
      readHostFileBase64: (root, relPath) => workspaceFs.readWorkspaceFileBase64(root, relPath),
      writeAppDataFile: (relativePath, bytes) =>
        appData.writeBlobToAppData(relativePath, new Blob([bytes as BlobPart])),
      appDataPath: appData.appDataPath,
      removeAppDataDirectory: appData.removeAppDataDirectory,
      walk: async (root) => {
        const result = await workspaceFs.walkWorkspace(root, {
          includeIgnored: true,
          maxEntries: MAX_DELIVERABLE_FILES * 5,
        })
        return {
          files: result.entries
            .filter((e) => !e.isDir)
            .map((e) => ({ relPath: e.relPath, size: e.size })),
          truncated: result.truncated,
        }
      },
      readText: async (root, relPath, maxBytes) => {
        const read = await workspaceFs.readWorkspaceFileVersioned(root, relPath, maxBytes)
        return { content: read.content, sha256: read.sha256, size: read.size }
      },
    },
    git: { acquire: acquireGitProbeWorkspace },
    now: Date.now,
  }
}

/**
 * A managed bundle at the task's frozen base, leased for one turn: the
 * Best-of-N candidate recipe (`lib/best-of-n/runtime.ts`) without the team run.
 */
async function acquireGitProbeWorkspace(input: {
  task: HarnessEvolutionTask
  sessionId: string
  characterId: string
  runId: string
  label: string
}): Promise<GitWorkspaceHandle> {
  const git = input.task.git
  if (!git?.resolvedBaseSha) throw new Error("A git rollout needs the run's resolved base commit")
  const [client, lease, userAction] = await Promise.all([
    import("@/lib/task-workspace/client"),
    import("@/lib/task-workspace/run-lease"),
    import("@/lib/task-workspace/user-action"),
  ])
  const logicalRootId = "harness-probe"
  const bundle = await userAction.runWorkspaceUserAction("task_workspace_bundle_acquire", () =>
    client.acquireWorkspaceBundle({
      ownerType: "session",
      ownerRef: input.sessionId,
      ...(git.projectId ? { projectId: git.projectId } : {}),
      environmentKind: "managed",
      base: { kind: "gitRef", gitRef: git.resolvedBaseSha as string },
      roots: [{ logicalRootId, role: "primary", sourceRoot: git.sourceRoot }],
    })
  )
  const primary = bundle.leases.find((l) => l.role === "primary")
  if (!primary || bundle.leases.length !== 1 || bundle.state !== "active") {
    throw new Error("The probe received an invalid workspace bundle")
  }
  const archive = async () => {
    await userAction.runWorkspaceUserAction("task_workspace_managed_archive", () =>
      client.archiveManagedWorkspace(primary.workspaceId)
    )
  }
  try {
    const portLease = await userAction.runWorkspaceUserAction(
      "task_workspace_port_lease_ensure",
      () => client.ensureWorkspacePortLease(primary.workspaceId)
    )
    const root = portLease.canonicalRoot
    const turn = await lease.openWorkspaceBundleTurnLease(bundle, logicalRootId, {
      taskId: `${input.runId}:${input.label}`,
      sessionId: input.sessionId,
      runId: `${input.runId}:${input.label}`,
      agentId: input.characterId,
      agentKind: "teammate",
      workspaceRoot: root,
      base: { kind: "gitRef", gitRef: git.resolvedBaseSha as string },
    })
    if (!turn) throw new Error("The probe workspace turn could not be leased")
    return {
      root,
      workspaceId: primary.workspaceId,
      settle: async (state) => (await turn.settle(state)).map((c) => c.path),
      acceptance: git.projectId
        ? async (profileIds, signal) =>
            runGitAcceptance({
              workspaceId: primary.workspaceId,
              projectId: git.projectId as string,
              sourceRoot: git.sourceRoot,
              title: `Harness probe ${input.label}`,
              profileIds,
              signal,
            })
        : undefined,
      archive,
    }
  } catch (error) {
    await archive().catch(() => {})
    throw error
  }
}

/** Capture the rollout's changes as a changeset and run the profiles against its head. */
async function runGitAcceptance(input: {
  workspaceId: string
  projectId: string
  sourceRoot: string
  title: string
  profileIds: readonly string[]
  signal: AbortSignal
}): Promise<Map<string, AcceptanceCheckOutcome>> {
  const [{ createScmHost }, { createScmRuntime }] = await Promise.all([
    import("@/lib/scm/host"),
    import("@/lib/scm/runtime"),
  ])
  const host = createScmHost()
  const out = new Map<string, AcceptanceCheckOutcome>()
  let changeset
  try {
    changeset = await host.captureChangeset({
      workspaceId: input.workspaceId,
      title: input.title,
      requiredChecks: [...input.profileIds],
    })
  } catch (error) {
    for (const id of input.profileIds) {
      out.set(id, {
        outcome: "inconclusive",
        detail: `no changes could be captured: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
    return out
  }
  const review = await createScmRuntime({
    projectId: input.projectId,
    configRoot: input.sourceRoot,
    appSettings: null,
    host,
  }).review(changeset.changesetId, input.signal)
  for (const id of input.profileIds) {
    const check = review.checks.find((c) => c.profileId === id)
    out.set(
      id,
      check
        ? { outcome: check.outcome, ...(check.logTail ? { detail: check.logTail } : {}) }
        : { outcome: "inconclusive", detail: "the profile did not run" }
    )
  }
  return out
}
