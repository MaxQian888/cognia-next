import type { ChatSession } from "@cognia/agent-config-types"
import { getSession, updateSession } from "@/lib/db/sessions"
import { registerDialogPathInRust } from "@/lib/files/allowed-roots-sync"
import { isTauri } from "@/lib/platform/detect"
import { decodeBase64, encodeBase64 } from "@/lib/share/encoding"
import type { SessionExecutionContext, SessionWorkspaceBinding } from "@/types/execution-context"
import {
  createSessionExecutionContext,
  resolveSessionWorkspaceRoot,
} from "./session-execution-context"
import { useProjectStore } from "@/stores/project/project-store"

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

export function createManagedWorkspaceContext(
  sessionId: string,
  now: number,
  localRoot?: string
): SessionExecutionContext {
  return createSessionExecutionContext({
    sessionId,
    projectId: "",
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
  const { worktreePath: _worktreePath, branch: _branch, ...portable } = context
  return {
    ...portable,
    projectRoot: "",
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
      ...incoming,
      projectRoot: local.managedWorkspace.localRoot,
      managedWorkspace: local.managedWorkspace,
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
  if (!isTauri()) throw new Error("Managed workspaces require the desktop app on this device")
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
