import type { ChatSession } from "@cognia/agent-config-types"
import { getSession, updateSession } from "@/lib/db/sessions"
import { registerDialogPathInRust } from "@/lib/files/allowed-roots-sync"
import { isHeadlessHost, isTauri } from "@/lib/platform/detect"
import { DEFAULT_PROJECT_ID } from "@/lib/db/project-defaults"
import { getRuntimeSnapshot } from "@/lib/runtime/runtime-snapshot-store"
import { assertSessionWritable } from "@/lib/chat/session-write-guard"
import { decodeBase64, encodeBase64 } from "@/lib/share/encoding"
import { sha256Hex } from "@/lib/share/hash"
import type { SessionExecutionContext, SessionWorkspaceBinding } from "@/types/execution-context"
import {
  createSessionExecutionContext,
  resolveSessionWorkspaceRoot,
} from "./session-execution-context"
import { useProjectStore } from "@/stores/project/project-store"
import {
  archiveManagedWorkspace,
  ensureSessionScratchWorkspaceBundle,
  getManagedWorkspace,
  getWorkspaceBundle,
  listWorkspaceBundles,
} from "./client"
import { runWorkspaceUserAction } from "./user-action"
import { validateSessionScratchBundle } from "./session-bundle"
import type { WorkspaceBundle } from "./types"

const ARCHIVE_VERSION = 1 as const
const MAX_ARCHIVE_FILES = 10_000
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024

export interface ManagedWorkspaceArchiveFile {
  path: string
  dataBase64: string
  size: number
}

export interface ManagedWorkspaceArchive {
  version: typeof ARCHIVE_VERSION
  workspaceId: string
  exportedAt: number
  files: ManagedWorkspaceArchiveFile[]
}

interface ManagedDirectoryEntry {
  name: string
  isDirectory: boolean
  isFile: boolean
  isSymlink?: boolean
}

export interface ManagedWorkspaceDeps {
  now: () => number
  managedBaseRoot: () => Promise<string>
  getSession: (sessionId: string) => Promise<ChatSession | undefined>
  updateSession: (sessionId: string, patch: Partial<ChatSession>) => Promise<unknown>
  exists: (path: string) => Promise<boolean>
  mkdir: (path: string) => Promise<unknown>
  rename: (from: string, to: string) => Promise<unknown>
  readDir: (path: string) => Promise<ManagedDirectoryEntry[]>
  readFile: (path: string) => Promise<Uint8Array>
  writeFile: (path: string, bytes: Uint8Array) => Promise<unknown>
  registerAllowedRoot: (path: string) => Promise<unknown>
  createProject: (rootDir: string, name: string) => { id: string }
  addSessionToProject: (projectId: string, sessionId: string) => unknown
}

function safeWorkspaceSegment(workspaceId: string): string {
  return workspaceId.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 128)
}

function joinPath(...segments: string[]): string {
  return segments
    .filter(Boolean)
    .map((segment, index) =>
      index === 0 ? segment.replace(/\/+$/, "") : segment.replace(/^\/+|\/+$/g, "")
    )
    .filter(Boolean)
    .join("/")
}

function managedWorkspaceId(sessionId: string): string {
  return `managed-workspace:${sessionId}`
}

/** Attribution to Default does not make these roots a Default project binding. */
export function isSessionScratchWorkspace(
  session:
    (Pick<ChatSession, "projectId" | "executionContext"> & { id?: string }) | null | undefined
): boolean {
  if (!session) return false
  const context = session.executionContext
  const binding = context?.workspaceBinding
  return (
    binding?.kind === "managed" &&
    context?.projectId === DEFAULT_PROJECT_ID &&
    (!session.projectId || session.projectId === DEFAULT_PROJECT_ID) &&
    (session.id
      ? binding.workspaceId === managedWorkspaceId(session.id)
      : /^managed-workspace:.+/.test(binding.workspaceId))
  )
}

export interface SessionScratchWorkspaceDeps {
  isHeadlessHost: () => boolean
  now: () => number
  getSession: (sessionId: string) => Promise<ChatSession | undefined>
  updateSession: (sessionId: string, patch: Partial<ChatSession>) => Promise<unknown>
  ensureBundle: (sessionId: string, bundleId?: string) => Promise<WorkspaceBundle>
}

const pendingSessionScratch = new Map<string, Promise<string>>()

function requireScratchEligibleSession(session: ChatSession | undefined): ChatSession {
  if (!session) throw new Error("Scratch workspace session no longer exists")
  if (
    !isSessionScratchWorkspace(session) &&
    (session.projectId ||
      session.executionContext?.projectId ||
      session.executionContext?.workspaceBinding?.kind === "project")
  ) {
    throw new Error("Project-bound sessions cannot acquire a scratch workspace")
  }
  return session
}

/** Upgrade old unbound IM sessions and reuse the host's durable session owner. */
export function ensureSessionScratchWorkspace(
  session: ChatSession,
  deps: SessionScratchWorkspaceDeps = {
    isHeadlessHost,
    now: Date.now,
    getSession,
    updateSession,
    ensureBundle: ensureSessionScratchWorkspaceBundle,
  }
): Promise<string> {
  if (!deps.isHeadlessHost()) {
    return Promise.reject(new Error("Session scratch workspaces require a headless host"))
  }
  const pending = pendingSessionScratch.get(session.id)
  if (pending) return pending
  const operation = (async () => {
    const current = requireScratchEligibleSession(await deps.getSession(session.id))
    const knownBundleId = current.executionContext?.execution?.bundleId
    const bundle = await deps.ensureBundle(current.id, knownBundleId)
    const primary = validateSessionScratchBundle(current.id, bundle, knownBundleId)
    const now = deps.now()
    const context = createManagedWorkspaceContext(
      current.id,
      now,
      primary.aliasPath,
      DEFAULT_PROJECT_ID
    )
    context.execution = {
      mode: "managed",
      base: { kind: "workingState" },
      bundleId: bundle.bundleId,
      roots: [
        {
          logicalRootId: primary.logicalRootId,
          role: "primary",
          aliasPath: primary.aliasPath,
          workspaceId: primary.workspaceId,
        },
      ],
    }
    context.lifecycle = {
      state: "active",
      createdAt: current.executionContext?.lifecycle?.createdAt ?? bundle.createdAt,
      updatedAt: now,
      pinned: bundle.pinned,
    }
    // A failed Dexie write is propagated. Retrying recovers the same host owner,
    // even when no bundle id ever reached the session row.
    const latest = requireScratchEligibleSession(await deps.getSession(current.id))
    const latestBundleId = latest.executionContext?.execution?.bundleId
    if (latestBundleId && latestBundleId !== bundle.bundleId) {
      throw new Error("Scratch workspace binding changed during provisioning")
    }
    await deps.updateSession(current.id, {
      projectId: DEFAULT_PROJECT_ID,
      executionContext: context,
    })
    return primary.aliasPath
  })().finally(() => pendingSessionScratch.delete(session.id))
  pendingSessionScratch.set(session.id, operation)
  return operation
}

/**
 * Archive before deleting the row, while its service-owned identity is available.
 * A ledger transaction passes its already-read row to avoid nesting encrypted
 * Dexie reads inside the hold for filesystem I/O.
 */
export async function archiveSessionScratchWorkspace(
  sessionOrId: ChatSession | string
): Promise<void> {
  const headless = isHeadlessHost()
  if (!headless && getRuntimeSnapshot().target?.kind !== "companion") return
  const session = typeof sessionOrId === "string" ? await getSession(sessionOrId) : sessionOrId
  if (!session?.platformBinding || !isSessionScratchWorkspace(session)) return
  const sessionId = session.id
  assertSessionWritable(session, "metadata")
  const bundleId = session.executionContext?.execution?.bundleId
  // Portable rows carry the owner identity, never a host bundle id. Resolve
  // that identity through the already-routed registry read on paired clients.
  // Do not ensure here: archiving a never-used session must not create files.
  const candidates = bundleId
    ? [await getWorkspaceBundle(bundleId)].filter((value): value is WorkspaceBundle => !!value)
    : (await listWorkspaceBundles()).filter(
        (bundle) => bundle.ownerType === "session" && bundle.ownerRef === sessionId
      )
  if (!candidates.length && !bundleId) return
  if (candidates.length !== 1) throw new Error("Scratch workspace bundle is missing or ambiguous")
  const bundle = candidates[0]
  const primary = validateSessionScratchBundle(sessionId, bundle, bundleId)
  const workspace = await getManagedWorkspace(primary.workspaceId)
  if (
    !workspace ||
    workspace.ownerType !== "session" ||
    workspace.ownerRef !== sessionId ||
    workspace.environmentKind !== "managed" ||
    workspace.isolationKind !== "shadow"
  ) {
    throw new Error("Scratch workspace registry ownership is invalid")
  }
  // Desktop rootless chats use the same portable managed identity. Only the
  // service scratch seed proves this row came from the always-on host command.
  const seedSuffix = `/sources/session-scratch/${await sha256Hex(sessionId)}`
  if (workspace.base.kind !== "workingState" || !workspace.sourceRoot.endsWith(seedSuffix)) {
    if (!headless) return
    throw new Error("Scratch workspace does not have a service-owned source")
  }
  await runWorkspaceUserAction("task_workspace_managed_archive", () =>
    archiveManagedWorkspace(primary.workspaceId)
  )
}

/**
 * The durable identity for a chat whose workspace has no directory to bind to.
 *
 * `projectId` still names the workspace the chat belongs to even though the
 * binding is `managed`: the two answer different questions. The binding says
 * "there is no checkout here", the project id says "this conversation is
 * ADR-0144-attributable to that workspace" — and the send path looks the
 * project up by it before opening a bundle. Omitting it stamped `""`, which
 * `.find(c => c.id === "")` never matches, so every rootless chat was refused
 * as `managed_project_unavailable` before its first turn ran. `planSessionMove`
 * has always kept the real id for the same condition; this matches it.
 */
export function createManagedWorkspaceContext(
  sessionId: string,
  now: number,
  localRoot?: string,
  projectId?: string
): SessionExecutionContext {
  return createSessionExecutionContext({
    sessionId,
    projectId: projectId?.trim() ?? "",
    projectRoot: localRoot ?? "",
    requestedLocation: "managedWorktree",
    isGitRepository: false,
    managedWorkspaceId: managedWorkspaceId(sessionId),
    managedWorkspaceRoot: localRoot,
    now,
  })
}

export function portableExecutionContext(
  context: SessionExecutionContext
): SessionExecutionContext {
  if (context.workspaceBinding?.kind !== "managed") return context
  const {
    worktreePath: _worktreePath,
    branch: _branch,
    environmentId: _environmentId,
    ...portable
  } = context
  return {
    ...portable,
    projectRoot: "",
    execution: context.execution
      ? { mode: context.execution.mode, base: context.execution.base, roots: [] }
      : undefined,
    taskWorkspace: {
      taskId: context.taskWorkspace.taskId,
      workspaceKey: context.taskWorkspace.workspaceKey,
    },
    managedWorkspace: { availability: "missing-on-device" },
  }
}

export function mergePortableManagedContext(
  incoming: SessionExecutionContext,
  local?: SessionExecutionContext
): SessionExecutionContext {
  if (incoming.workspaceBinding?.kind !== "managed") return incoming
  if (
    local?.workspaceBinding?.kind === "managed" &&
    local.workspaceBinding.workspaceId === incoming.workspaceBinding.workspaceId &&
    local.managedWorkspace?.availability === "available" &&
    local.managedWorkspace.localRoot
  ) {
    return {
      ...portableExecutionContext(incoming),
      projectRoot: local.managedWorkspace.localRoot,
      managedWorkspace: local.managedWorkspace,
      execution: local.execution,
      taskWorkspace: local.taskWorkspace,
      ...(local.environmentId ? { environmentId: local.environmentId } : {}),
      ...(local.worktreePath ? { worktreePath: local.worktreePath } : {}),
      ...(local.branch ? { branch: local.branch } : {}),
    }
  }
  return portableExecutionContext(incoming)
}

type ManagedExecutionContext = SessionExecutionContext & {
  workspaceBinding: Extract<SessionWorkspaceBinding, { kind: "managed" }>
}

function requireManagedContext(session: ChatSession | undefined): ManagedExecutionContext {
  const context = session?.executionContext
  if (context?.workspaceBinding?.kind !== "managed") {
    throw new Error("Session is not bound to a managed workspace")
  }
  return context as ManagedExecutionContext
}

async function persistContext(
  sessionId: string,
  context: SessionExecutionContext,
  deps: ManagedWorkspaceDeps
): Promise<SessionExecutionContext> {
  await deps.updateSession(sessionId, { executionContext: context })
  return context
}

export async function materializeManagedWorkspace(
  sessionId: string,
  providedDeps?: ManagedWorkspaceDeps
): Promise<SessionExecutionContext> {
  const deps = providedDeps ?? (await defaultManagedWorkspaceDeps())
  const context = requireManagedContext(await deps.getSession(sessionId))
  if (
    context.managedWorkspace?.availability === "available" &&
    context.managedWorkspace.localRoot &&
    (await deps.exists(context.managedWorkspace.localRoot))
  ) {
    return context
  }
  const baseRoot = await deps.managedBaseRoot()
  const localRoot = joinPath(baseRoot, safeWorkspaceSegment(context.workspaceBinding!.workspaceId))
  await deps.mkdir(localRoot)
  await deps.registerAllowedRoot(localRoot)
  const now = deps.now()
  return persistContext(
    sessionId,
    {
      ...context,
      projectRoot: localRoot,
      managedWorkspace: { availability: "available", localRoot, materializedAt: now },
    },
    deps
  )
}

export async function rebindManagedWorkspace(
  sessionId: string,
  localRoot: string,
  providedDeps?: ManagedWorkspaceDeps
): Promise<SessionExecutionContext> {
  const deps = providedDeps ?? (await defaultManagedWorkspaceDeps())
  const normalizedRoot = localRoot.trim().replace(/\/+$/, "")
  if (!normalizedRoot || !(await deps.exists(normalizedRoot))) {
    throw new Error("Managed workspace directory does not exist")
  }
  const context = requireManagedContext(await deps.getSession(sessionId))
  await deps.registerAllowedRoot(normalizedRoot)
  return persistContext(
    sessionId,
    {
      ...context,
      projectRoot: normalizedRoot,
      worktreePath: undefined,
      branch: undefined,
      managedWorkspace: {
        availability: "available",
        localRoot: normalizedRoot,
        reboundAt: deps.now(),
      },
    },
    deps
  )
}

export async function deleteManagedWorkspace(
  sessionId: string,
  providedDeps?: ManagedWorkspaceDeps
): Promise<SessionExecutionContext> {
  const deps = providedDeps ?? (await defaultManagedWorkspaceDeps())
  const context = requireManagedContext(await deps.getSession(sessionId))
  const localRoot = context.managedWorkspace?.localRoot
  if (context.managedWorkspace?.availability !== "available" || !localRoot) {
    throw new Error("Managed workspace is not available on this device")
  }
  if (!(await deps.exists(localRoot))) {
    throw new Error("Managed workspace directory does not exist")
  }
  const baseRoot = await deps.managedBaseRoot()
  const trashRoot = joinPath(
    baseRoot,
    ".trash",
    `${safeWorkspaceSegment(context.workspaceBinding!.workspaceId)}-${deps.now()}`
  )
  await deps.mkdir(joinPath(baseRoot, ".trash"))
  await deps.rename(localRoot, trashRoot)
  return persistContext(
    sessionId,
    {
      ...context,
      projectRoot: "",
      worktreePath: undefined,
      branch: undefined,
      managedWorkspace: {
        availability: "deleted",
        deletedRoot: trashRoot,
        deletedAt: deps.now(),
      },
    },
    deps
  )
}

export async function restoreManagedWorkspace(
  sessionId: string,
  providedDeps?: ManagedWorkspaceDeps
): Promise<SessionExecutionContext> {
  const deps = providedDeps ?? (await defaultManagedWorkspaceDeps())
  const context = requireManagedContext(await deps.getSession(sessionId))
  const deletedRoot = context.managedWorkspace?.deletedRoot
  if (context.managedWorkspace?.availability !== "deleted" || !deletedRoot) {
    throw new Error("Managed workspace has no recoverable deletion")
  }
  if (!(await deps.exists(deletedRoot))) {
    throw new Error("Recoverable managed workspace data is unavailable")
  }
  const baseRoot = await deps.managedBaseRoot()
  const localRoot = joinPath(baseRoot, safeWorkspaceSegment(context.workspaceBinding!.workspaceId))
  if (await deps.exists(localRoot))
    throw new Error("Managed workspace restore target already exists")
  await deps.rename(deletedRoot, localRoot)
  await deps.registerAllowedRoot(localRoot)
  return persistContext(
    sessionId,
    {
      ...context,
      projectRoot: localRoot,
      managedWorkspace: {
        availability: "available",
        localRoot,
        materializedAt: deps.now(),
      },
    },
    deps
  )
}

function assertSafeRelativePath(path: string): void {
  if (
    !path ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /^[a-zA-Z]:/.test(path) ||
    path.split(/[\\/]/).some((segment) => segment === ".." || segment === "")
  ) {
    throw new Error(`Managed workspace archive contains unsafe path: ${path}`)
  }
}

async function collectArchiveFiles(
  root: string,
  deps: ManagedWorkspaceDeps
): Promise<ManagedWorkspaceArchiveFile[]> {
  const files: ManagedWorkspaceArchiveFile[] = []
  let totalBytes = 0
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = [...(await deps.readDir(directory))].sort((a, b) =>
      a.name.localeCompare(b.name)
    )
    for (const entry of entries) {
      if (entry.isSymlink) throw new Error("Managed workspace archives do not follow symlinks")
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      assertSafeRelativePath(relativePath)
      const absolutePath = joinPath(root, relativePath)
      if (entry.isDirectory) {
        await visit(absolutePath, relativePath)
      } else if (entry.isFile) {
        const bytes = await deps.readFile(absolutePath)
        totalBytes += bytes.byteLength
        if (files.length >= MAX_ARCHIVE_FILES || totalBytes > MAX_ARCHIVE_BYTES) {
          throw new Error("Managed workspace archive exceeds the safety limit")
        }
        files.push({ path: relativePath, dataBase64: encodeBase64(bytes), size: bytes.byteLength })
      }
    }
  }
  await visit(root, "")
  return files
}

export async function createManagedWorkspaceArchive(
  sessionId: string,
  providedDeps?: ManagedWorkspaceDeps
): Promise<ManagedWorkspaceArchive> {
  const deps = providedDeps ?? (await defaultManagedWorkspaceDeps())
  const context = requireManagedContext(await deps.getSession(sessionId))
  const localRoot = context.managedWorkspace?.localRoot
  if (context.managedWorkspace?.availability !== "available" || !localRoot) {
    throw new Error("Managed workspace is not available on this device")
  }
  return {
    version: ARCHIVE_VERSION,
    workspaceId: context.workspaceBinding!.workspaceId,
    exportedAt: deps.now(),
    files: await collectArchiveFiles(localRoot, deps),
  }
}

export async function importManagedWorkspaceArchive(
  sessionId: string,
  archive: ManagedWorkspaceArchive,
  targetRoot: string,
  providedDeps?: ManagedWorkspaceDeps
): Promise<SessionExecutionContext> {
  const deps = providedDeps ?? (await defaultManagedWorkspaceDeps())
  const context = requireManagedContext(await deps.getSession(sessionId))
  if (archive.version !== ARCHIVE_VERSION) throw new Error("Unsupported managed workspace archive")
  if (archive.workspaceId !== context.workspaceBinding!.workspaceId) {
    throw new Error("Managed workspace archive belongs to another workspace")
  }
  if (archive.files.length > MAX_ARCHIVE_FILES) {
    throw new Error("Managed workspace archive exceeds the safety limit")
  }
  let totalBytes = 0
  const decoded = archive.files.map((file) => {
    assertSafeRelativePath(file.path)
    const bytes = decodeBase64(file.dataBase64)
    if (bytes.byteLength !== file.size) throw new Error(`Invalid archive size for ${file.path}`)
    totalBytes += bytes.byteLength
    if (totalBytes > MAX_ARCHIVE_BYTES) {
      throw new Error("Managed workspace archive exceeds the safety limit")
    }
    return { path: file.path.replace(/\\/g, "/"), bytes }
  })
  if (!(await deps.exists(targetRoot))) await deps.mkdir(targetRoot)
  for (const file of decoded) {
    const segments = file.path.split("/")
    if (segments.length > 1) {
      await deps.mkdir(joinPath(targetRoot, ...segments.slice(0, -1)))
    }
    await deps.writeFile(joinPath(targetRoot, file.path), file.bytes)
  }
  return rebindManagedWorkspace(sessionId, targetRoot, deps)
}

export async function convertManagedWorkspaceToProject(
  sessionId: string,
  name: string,
  providedDeps?: ManagedWorkspaceDeps
): Promise<{ projectId: string; context: SessionExecutionContext }> {
  const deps = providedDeps ?? (await defaultManagedWorkspaceDeps())
  const session = await deps.getSession(sessionId)
  const context = requireManagedContext(session)
  const localRoot = context.managedWorkspace?.localRoot
  if (context.managedWorkspace?.availability !== "available" || !localRoot) {
    throw new Error("Managed workspace is not available on this device")
  }
  if (!(await deps.exists(localRoot))) throw new Error("Managed workspace directory does not exist")
  const project = deps.createProject(localRoot, name)
  deps.addSessionToProject(project.id, sessionId)
  const projectContext: SessionExecutionContext = {
    ...context,
    location: "local",
    workspaceBinding: { kind: "project", projectId: project.id },
    managedWorkspace: undefined,
    projectId: project.id,
    projectRoot: localRoot,
    worktreePath: undefined,
    branch: undefined,
    lifecycle: undefined,
  }
  await deps.updateSession(sessionId, { projectId: project.id, executionContext: projectContext })
  return { projectId: project.id, context: projectContext }
}

export function managedWorkspaceRoot(context: SessionExecutionContext): string | undefined {
  return resolveSessionWorkspaceRoot(context)
}

async function defaultManagedWorkspaceDeps(): Promise<ManagedWorkspaceDeps> {
  // Only the desktop has an implementation, not only the desktop COULD have
  // one: a paired browser or phone reaches a real filesystem through the
  // companion transport, and `lib/files/workspace-fs.ts` already exposes the
  // pieces (`listWorkspaceRoots` reports a headless Host's writable root,
  // `createWorkspaceDir` and `statWorkspaceFile` go over `transport.call`).
  // Say which of the two this is, so the message does not read as a permanent
  // property of browsers and send someone looking for a setting to flip.
  if (!isTauri()) {
    throw new Error(
      "materializing a managed workspace needs the desktop app: no host-backed implementation exists yet"
    )
  }
  const [{ appLocalDataDir }, fs] = await Promise.all([
    import("@tauri-apps/api/path"),
    import("@tauri-apps/plugin-fs"),
  ])
  return {
    now: Date.now,
    managedBaseRoot: async () => joinPath(await appLocalDataDir(), "managed-workspaces"),
    getSession,
    updateSession,
    exists: fs.exists,
    mkdir: (path) => fs.mkdir(path, { recursive: true }),
    rename: fs.rename,
    readDir: fs.readDir,
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    registerAllowedRoot: registerDialogPathInRust,
    createProject: (rootDir, name) => useProjectStore.getState().createProject({ name, rootDir }),
    addSessionToProject: (projectId, sessionId) =>
      useProjectStore.getState().addSessionToProject(projectId, sessionId),
  }
}
