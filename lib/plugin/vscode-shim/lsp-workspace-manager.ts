/**
 * LSP workspace materialiser.
 *
 * The cognia editor surfaces (Skills / Canvas / Artifact) are in-memory
 * Monaco models — they have no on-disk presence. Real-world Language
 * Servers (rust-analyzer, gopls, pylsp, ESLint with caching) want a
 * `workspaceFolder` to read files from. This module bridges that gap by
 * materialising the active Monaco content onto a per-surface workspace
 * directory under `<app_data>/cognia/lsp-workspaces/`.
 *
 * Lifecycle:
 *
 *   1. `ensureWorkspace({ surface, documentId, ... })` is called when an
 *      LSP server is about to be spawned for the editor. The manager
 *      creates a fresh workspace directory if needed, writes the initial
 *      content of the document, and returns the absolute path.
 *
 *   2. `flushDocument(...)` is called on every Monaco `onDidChangeContent`
 *      event. Flushes coalesce within a 250 ms debounce window — bursts
 *      of typing collapse to one `writeFile` per document.
 *
 *   3. `disposeWorkspace(...)` is called when the editor unmounts or the
 *      LSP server shuts down. Pending flushes drain, the directory is
 *      kept on disk for audit (cleanup is a separate sweep step at app
 *      shutdown via `disposeAllWorkspaces`).
 *
 *   4. `resolveWorkspaceFolder(uri)` answers the sidecar's
 *      `workspace.workspaceFolders` query: given a `skill:///…` /
 *      `canvas:///…` / `artifact:///…` URI, returns the matching
 *      `{ uri: file://…, name }` pair, or `null` if no workspace exists.
 *
 * The fs implementation is injected so tests can use an in-memory map
 * without touching the real filesystem. The default implementation uses
 * Tauri's `@tauri-apps/plugin-fs` to write into the app's data dir.
 */

import { loggers } from "@cognia/logging"
import { pathToFileUri } from "@/lib/files/path-uri"

const workspaceLogger = loggers.plugin.child("lsp-workspace-manager")

/** Surface key matching the workbench URI scheme (`skill` / `canvas` / `artifact` / `file`). */
export type LspWorkspaceSurface = "skill" | "canvas" | "artifact" | "file" | (string & {})

/** Input for `ensureWorkspace` — uniquely identifies a materialised workspace. */
export interface LspWorkspaceSpec {
  /** Surface this workspace belongs to. */
  surface: LspWorkspaceSurface
  /** Stable document id within the surface. */
  documentId: string
  /** Filename to materialise (e.g. `skill-abc.ts`). The extension drives LSP language detection. */
  fileName: string
  /** Initial content to write. */
  initialContent: string | Uint8Array
  /** The Monaco URI this workspace is anchored to — used for reverse lookup. */
  monacoUri: string
}

/** Filesystem adapter the manager calls through. */
export interface LspWorkspaceFsAdapter {
  /** Resolve the cognia app-data directory (e.g. `<home>/AppData/Roaming/cognia/`). */
  appDataDir(): Promise<string>
  /** Create `path` and all missing parents. Idempotent. */
  createDir(path: string): Promise<void>
  /** Atomically write `content` to `path`. */
  writeFile(path: string, content: string): Promise<void>
  /** Write binary content when a workspace contains non-text Skill assets. */
  writeBinaryFile?(path: string, content: Uint8Array): Promise<void>
  /** Remove `path` recursively. Idempotent — missing path is not an error. */
  removeDir(path: string): Promise<void>
  /**
   * Join path segments using the platform separator. Synchronous because
   * every Tauri impl already exposes a sync `joinPath` and tests need
   * straightforward equality.
   */
  joinPath(...segments: string[]): string
  /**
   * Convert an absolute filesystem path to a `file://` URI. Synchronous
   * because all Tauri/Node paths can be encoded without IO.
   */
  pathToFileUri(absolutePath: string): string
}

interface PendingFlush {
  content: string
  handle: ReturnType<typeof setTimeout>
  /** Resolvers of every `flushDocument` call coalesced into this one write. */
  resolvers: Array<() => void>
  /** Rejectors mirroring `resolvers` — fired with the writeFile error. */
  rejectors: Array<(err: Error) => void>
}

/** Internal record kept per allocated workspace. */
interface AllocatedWorkspace {
  spec: LspWorkspaceSpec
  workspacePath: string
  filePath: string
  fileUri: string
  pendingFlush?: PendingFlush
  documents: Map<
    string,
    {
      filePath: string
      fileUri: string
      pendingFlush?: PendingFlush
    }
  >
}

/** Debounce window for content flushes — bursts of typing coalesce. */
export const FLUSH_DEBOUNCE_MS = 250

let fsImpl: LspWorkspaceFsAdapter | null = null

/** Override the fs adapter — used by tests and by the Tauri bootstrap. */
export function configureLspWorkspaceManager(adapter: LspWorkspaceFsAdapter | null): void {
  fsImpl = adapter
}

export function isLspWorkspaceManagerConfigured(): boolean {
  return fsImpl !== null
}

/** Test-only: clear every cached workspace + restore default state. */
export function __resetLspWorkspaceManagerForTesting(): void {
  workspaces.clear()
  monacoUriToWorkspace.clear()
  fileUriToMonacoUri.clear()
  workspaceFolderListeners.clear()
  projectWorkspaces.clear()
  fsImpl = null
}

const workspaces = new Map<string, AllocatedWorkspace>()
const monacoUriToWorkspace = new Map<string, string>()
const fileUriToMonacoUri = new Map<string, string>()
const workspaceFolderListeners = new Set<() => void>()

export function onWorkspaceFoldersChanged(listener: () => void): () => void {
  workspaceFolderListeners.add(listener)
  return () => workspaceFolderListeners.delete(listener)
}

function notifyWorkspaceFoldersChanged(): void {
  for (const listener of workspaceFolderListeners) listener()
}

// ────────────────────────────────────────────────────────────────────────
// Real-project workspaces (the Monaco `file` surface / project editor).
//
// Unlike the synthetic per-document workspaces above, these point at a real
// on-disk directory (a team `workingDir` or a git worktree). Nothing is
// materialised — the files already exist on disk — so there is no flush and
// no cleanup sweep. The manager only needs to answer the sidecar's
// `workspace.workspaceFolders` / `getWorkspaceFolder(uri)` queries for
// `file://` documents so real Language Servers (rust-analyzer / gopls /
// pyright / tsserver) root at the actual project and resolve cross-file.
// ────────────────────────────────────────────────────────────────────────

interface ProjectWorkspace {
  /** Absolute on-disk root path (normalised to forward slashes). */
  root: string
  /** `file://` URI of the root — the `workspaceFolder.uri` the sidecar sees. */
  rootUri: string
  /** Human-facing folder name (defaults to the last path segment). */
  name: string
}

/** Keyed by `rootUri` so re-registering the same root is idempotent. */
const projectWorkspaces = new Map<string, ProjectWorkspace>()

function deriveWorkspaceName(root: string): string {
  const normalised = root.replace(/\\/g, "/").replace(/\/+$/g, "")
  const segments = normalised.split("/").filter(Boolean)
  return segments[segments.length - 1] ?? normalised
}

/**
 * Register a real project root as an LSP `workspaceFolder`. Idempotent per
 * root. Returns the `file://` root URI the sidecar will expose. Call this when
 * a project editor mounts (or switches root); pair with
 * `unregisterProjectWorkspace(root)` on unmount / root change.
 */
export function registerProjectWorkspace(root: string, name?: string): string {
  const rootUri = pathToFileUri(root.replace(/\/+$/g, ""))
  const existing = projectWorkspaces.get(rootUri)
  if (existing) {
    if (name && name !== existing.name) existing.name = name
    return rootUri
  }
  projectWorkspaces.set(rootUri, {
    root,
    rootUri,
    name: name ?? deriveWorkspaceName(root),
  })
  workspaceLogger.debug("project workspace registered", { root, rootUri })
  notifyWorkspaceFoldersChanged()
  return rootUri
}

/** Remove a previously-registered project root. Idempotent. */
export function unregisterProjectWorkspace(root: string): void {
  const rootUri = pathToFileUri(root.replace(/\/+$/g, ""))
  if (projectWorkspaces.delete(rootUri)) notifyWorkspaceFoldersChanged()
}

/** Test-only helper mirroring the reset above for focused suites. */
export function __resetProjectWorkspacesForTesting(): void {
  projectWorkspaces.clear()
}

/**
 * Longest-prefix match of a `file://` document URI against the registered
 * project roots. Returns the enclosing project workspace or `null`.
 */
function matchProjectWorkspace(fileUri: string): ProjectWorkspace | null {
  let best: ProjectWorkspace | null = null
  for (const ws of projectWorkspaces.values()) {
    if (fileUri === ws.rootUri || fileUri.startsWith(`${ws.rootUri}/`)) {
      if (!best || ws.rootUri.length > best.rootUri.length) best = ws
    }
  }
  return best
}

function makeKey(spec: Pick<LspWorkspaceSpec, "surface" | "documentId">): string {
  return `${spec.surface}::${spec.documentId}`
}

function assertConfigured(): LspWorkspaceFsAdapter {
  if (!fsImpl) {
    throw new Error(
      "lsp-workspace-manager: configureLspWorkspaceManager must be called before any workspace operation"
    )
  }
  return fsImpl
}

function normalizeRelativeFileName(fileName: string): string {
  const normalized = fileName.replace(/\\/g, "/").replace(/^\/+/, "")
  const segments = normalized.split("/")
  if (!normalized || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`lsp-workspace-manager: unsafe relative file name ${fileName}`)
  }
  return normalized
}

async function writeInitialFile(
  fs: LspWorkspaceFsAdapter,
  path: string,
  content: string | Uint8Array
): Promise<void> {
  if (typeof content === "string") return fs.writeFile(path, content)
  if (!fs.writeBinaryFile) {
    throw new Error("lsp-workspace-manager: binary workspace writes are unavailable")
  }
  return fs.writeBinaryFile(path, content)
}

/**
 * Allocate (or return) the workspace for a Monaco document. Materialises
 * the initial content on first call; subsequent calls with the same
 * surface/documentId are idempotent (the content on disk may be stale —
 * call `flushDocument` to update it).
 */
export async function ensureWorkspace(spec: LspWorkspaceSpec): Promise<string> {
  const fs = assertConfigured()
  const key = makeKey(spec)
  const fileName = normalizeRelativeFileName(spec.fileName)
  const existing = workspaces.get(key)
  if (existing) {
    if (!existing.documents.has(spec.monacoUri)) {
      const filePath = fs.joinPath(existing.workspacePath, fileName)
      const parent = filePath.replace(/\\/g, "/").replace(/\/[^/]+$/, "")
      if (parent && parent !== existing.workspacePath) await fs.createDir(parent)
      await writeInitialFile(fs, filePath, spec.initialContent)
      const fileUri = fs.pathToFileUri(filePath)
      existing.documents.set(spec.monacoUri, { filePath, fileUri })
      monacoUriToWorkspace.set(spec.monacoUri, key)
      fileUriToMonacoUri.set(fileUri, spec.monacoUri)
    }
    return existing.workspacePath
  }

  const appData = await fs.appDataDir()
  const workspacePath = fs.joinPath(
    appData,
    "cognia",
    "lsp-workspaces",
    `${spec.surface}-${spec.documentId}`
  )
  await fs.createDir(workspacePath)

  const filePath = fs.joinPath(workspacePath, fileName)
  const parent = filePath.replace(/\\/g, "/").replace(/\/[^/]+$/, "")
  if (parent && parent !== workspacePath) await fs.createDir(parent)
  await writeInitialFile(fs, filePath, spec.initialContent)

  const record: AllocatedWorkspace = {
    spec,
    workspacePath,
    filePath,
    fileUri: fs.pathToFileUri(filePath),
    documents: new Map(),
  }
  record.documents.set(spec.monacoUri, { filePath: record.filePath, fileUri: record.fileUri })
  workspaces.set(key, record)
  monacoUriToWorkspace.set(spec.monacoUri, key)
  fileUriToMonacoUri.set(record.fileUri, spec.monacoUri)
  notifyWorkspaceFoldersChanged()

  workspaceLogger.debug("workspace allocated", {
    surface: spec.surface,
    documentId: spec.documentId,
    workspacePath,
  })

  return workspacePath
}

/** Materialise every file belonging to one logical editor workspace. */
export async function ensureWorkspaceFiles(input: {
  surface: LspWorkspaceSurface
  workspaceId: string
  files: Array<Pick<LspWorkspaceSpec, "fileName" | "initialContent" | "monacoUri">>
}): Promise<string | null> {
  let workspacePath: string | null = null
  for (const file of input.files) {
    workspacePath = await ensureWorkspace({
      surface: input.surface,
      documentId: input.workspaceId,
      ...file,
    })
  }
  return workspacePath
}

/**
 * Queue a content write for the document. Coalesces with any pending
 * write — the latest `content` wins after `FLUSH_DEBOUNCE_MS` of quiet.
 *
 * Returns a promise that resolves once the disk write completes; useful
 * for tests and for `disposeWorkspace` ordering. If a newer flush is
 * queued before the current one fires, the returned promise still
 * resolves when *that* (newer) write finishes — callers waiting for
 * "settled" semantics are not surprised by stale-data writes.
 */
export function flushDocument(
  spec: Pick<LspWorkspaceSpec, "surface" | "documentId">,
  content: string
): Promise<void> {
  const fs = assertConfigured()
  const key = makeKey(spec)
  const record = workspaces.get(key)
  if (!record) {
    return Promise.reject(
      new Error(
        `lsp-workspace-manager: flushDocument called for unknown workspace ${spec.surface}/${spec.documentId}`
      )
    )
  }

  return new Promise<void>((resolve, reject) => {
    if (record.pendingFlush) {
      // Extend the existing debounce: update the content + register this
      // caller's resolvers so they fire together with the final write.
      clearTimeout(record.pendingFlush.handle)
      record.pendingFlush.content = content
      record.pendingFlush.resolvers.push(resolve)
      record.pendingFlush.rejectors.push(reject)
      record.pendingFlush.handle = setTimeout(() => fireFlush(record, fs, spec), FLUSH_DEBOUNCE_MS)
      return
    }
    record.pendingFlush = {
      content,
      handle: setTimeout(() => fireFlush(record, fs, spec), FLUSH_DEBOUNCE_MS),
      resolvers: [resolve],
      rejectors: [reject],
    }
  })
}

/** Flush a materialised editor document by its stable Monaco URI. */
export function flushMaterializedDocument(monacoUri: string, content: string): Promise<void> {
  const fs = assertConfigured()
  const key = monacoUriToWorkspace.get(monacoUri)
  const record = key ? workspaces.get(key) : undefined
  const document = record?.documents.get(monacoUri)
  if (!record || !document) {
    return Promise.reject(
      new Error(`lsp-workspace-manager: no materialised document for ${monacoUri}`)
    )
  }
  if (monacoUri === record.spec.monacoUri) {
    return flushDocument(
      { surface: record.spec.surface, documentId: record.spec.documentId },
      content
    )
  }
  return new Promise<void>((resolve, reject) => {
    if (document.pendingFlush) {
      clearTimeout(document.pendingFlush.handle)
      document.pendingFlush.content = content
      document.pendingFlush.resolvers.push(resolve)
      document.pendingFlush.rejectors.push(reject)
    } else {
      document.pendingFlush = {
        content,
        handle: 0 as never,
        resolvers: [resolve],
        rejectors: [reject],
      }
    }
    document.pendingFlush.handle = setTimeout(() => {
      const pending = document.pendingFlush
      if (!pending) return
      document.pendingFlush = undefined
      fs.writeFile(document.filePath, pending.content)
        .then(() => pending.resolvers.forEach((done) => done()))
        .catch((error) => {
          const err = error instanceof Error ? error : new Error(String(error))
          pending.rejectors.forEach((fail) => fail(err))
        })
    }, FLUSH_DEBOUNCE_MS)
  })
}

function fireFlush(
  record: AllocatedWorkspace,
  fs: LspWorkspaceFsAdapter,
  spec: Pick<LspWorkspaceSpec, "surface" | "documentId">
): void {
  const pending = record.pendingFlush
  if (!pending) return
  record.pendingFlush = undefined
  fs.writeFile(record.filePath, pending.content)
    .then(() => {
      for (const r of pending.resolvers) r()
    })
    .catch((err) => {
      workspaceLogger.warn("flushDocument writeFile failed", {
        surface: spec.surface,
        documentId: spec.documentId,
        error: err instanceof Error ? err.message : String(err),
      })
      const error = err instanceof Error ? err : new Error(String(err))
      for (const rej of pending.rejectors) rej(error)
    })
}

/**
 * Tear down the workspace. Drains any pending flush (writes the
 * latest-queued content) then removes the directory. Idempotent.
 */
export async function disposeWorkspace(
  spec: Pick<LspWorkspaceSpec, "surface" | "documentId">
): Promise<void> {
  const fs = assertConfigured()
  const key = makeKey(spec)
  const record = workspaces.get(key)
  if (!record) return

  if (record.pendingFlush) {
    const pending = record.pendingFlush
    clearTimeout(pending.handle)
    record.pendingFlush = undefined
    try {
      await fs.writeFile(record.filePath, pending.content)
      for (const r of pending.resolvers) r()
    } catch (err) {
      workspaceLogger.warn("final flush before dispose failed", {
        surface: spec.surface,
        documentId: spec.documentId,
        error: err instanceof Error ? err.message : String(err),
      })
      const error = err instanceof Error ? err : new Error(String(err))
      for (const rej of pending.rejectors) rej(error)
    }
  }

  for (const [monacoUri, document] of record.documents) {
    if (monacoUri === record.spec.monacoUri || !document.pendingFlush) continue
    const pending = document.pendingFlush
    clearTimeout(pending.handle)
    document.pendingFlush = undefined
    try {
      await fs.writeFile(document.filePath, pending.content)
      for (const done of pending.resolvers) done()
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      for (const fail of pending.rejectors) fail(err)
    }
  }

  workspaces.delete(key)
  for (const [monacoUri, document] of record.documents) {
    monacoUriToWorkspace.delete(monacoUri)
    fileUriToMonacoUri.delete(document.fileUri)
  }

  try {
    await fs.removeDir(record.workspacePath)
  } catch (err) {
    workspaceLogger.warn("removeDir failed during dispose", {
      surface: spec.surface,
      documentId: spec.documentId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  notifyWorkspaceFoldersChanged()
}

/**
 * Dispose every allocated workspace. Called at app shutdown to free disk
 * space without leaking workspace directories.
 */
export async function disposeAllWorkspaces(): Promise<void> {
  const keys = [...workspaces.keys()]
  for (const key of keys) {
    const record = workspaces.get(key)
    if (!record) continue
    await disposeWorkspace({
      surface: record.spec.surface,
      documentId: record.spec.documentId,
    })
  }
}

/**
 * Reverse-lookup: given a Monaco URI, return the `WorkspaceFolder` the
 * sidecar should expose to extensions. Returns `null` if there is no
 * matching workspace (i.e. no LSP has been started for that editor).
 *
 * The sidecar calls this through a renderer→sidecar RPC every time an
 * extension reads `vscode.workspace.workspaceFolders` or
 * `vscode.workspace.getWorkspaceFolder(uri)`. Cheap O(1) map lookup;
 * safe to call on every keystroke.
 */
export function resolveWorkspaceFolder(monacoUri: string): { uri: string; name: string } | null {
  // Real project (`file://`) documents win: return the enclosing project root
  // so cross-file navigation resolves against the actual directory.
  if (monacoUri.startsWith("file://")) {
    const project = matchProjectWorkspace(monacoUri)
    if (project) return { uri: project.rootUri, name: project.name }
  }

  const key = monacoUriToWorkspace.get(monacoUri)
  if (!key) return null
  const record = workspaces.get(key)
  if (!record) return null
  // Workspace folder URI is the directory, not the file.
  const dirUri = record.fileUri.substring(0, record.fileUri.lastIndexOf("/"))
  return {
    uri: dirUri,
    name: `${record.spec.surface}-${record.spec.documentId}`,
  }
}

/** Translate an editor model URI to the materialised URI sent to an LSP. */
export function resolveMaterializedDocumentUri(monacoUri: string): string | null {
  if (monacoUri.startsWith("file://")) return monacoUri
  const key = monacoUriToWorkspace.get(monacoUri)
  const record = key ? workspaces.get(key) : undefined
  return record?.documents.get(monacoUri)?.fileUri ?? null
}

/** Translate an LSP `file://` URI back to the stable Monaco model URI. */
export function resolveMonacoDocumentUri(fileUri: string): string {
  return fileUriToMonacoUri.get(fileUri) ?? fileUri
}

/**
 * Enumerate every workspace folder currently materialised — the answer
 * to `vscode.workspace.workspaceFolders` from a sidecar that hasn't
 * specified a URI. Stable insertion order.
 */
export function listWorkspaceFolders(): Array<{ uri: string; name: string; documentUri: string }> {
  const synthetic = [...workspaces.values()].map((record) => {
    const dirUri = record.fileUri.substring(0, record.fileUri.lastIndexOf("/"))
    return {
      uri: dirUri,
      name: `${record.spec.surface}-${record.spec.documentId}`,
      documentUri: record.fileUri,
    }
  })
  // Real project roots are listed first — they are the primary workspace for
  // the editor, and a server keying off the first folder should see the
  // project, not a materialised per-document scratch dir.
  const projects = [...projectWorkspaces.values()].map((ws) => ({
    uri: ws.rootUri,
    name: ws.name,
    documentUri: ws.rootUri,
  }))
  return [...projects, ...synthetic]
}

/**
 * Default Tauri-backed fs adapter. Lazy-imported the first time it is
 * requested so non-desktop builds don't pull `@tauri-apps/plugin-fs`.
 *
 * The adapter uses Tauri's `@tauri-apps/plugin-fs` v2 API with
 * `BaseDirectory.AppData` so paths are resolved within the cognia app
 * sandbox (no escape to the host filesystem).
 */
export async function createDefaultTauriFsAdapter(): Promise<LspWorkspaceFsAdapter> {
  const [fs, pathMod] = await Promise.all([
    import("@tauri-apps/plugin-fs"),
    import("@tauri-apps/api/path"),
  ])
  return {
    async appDataDir() {
      return pathMod.appDataDir()
    },
    async createDir(path) {
      await fs.mkdir(path, { recursive: true })
    },
    async writeFile(path, content) {
      await fs.writeTextFile(path, content)
    },
    async writeBinaryFile(path, content) {
      await fs.writeFile(path, content)
    },
    async removeDir(path) {
      try {
        await fs.remove(path, { recursive: true })
      } catch {
        // Idempotent — missing path is not an error.
      }
    },
    joinPath(...segments) {
      // Tauri's join is async; we need sync behaviour. The path
      // primitives accept forward slashes on every platform Tauri
      // supports, so a manual join is correct and avoids the async hop.
      return segments
        .filter((s) => s.length > 0)
        .map((s) => s.replace(/\\/g, "/").replace(/\/+$/g, ""))
        .join("/")
    },
    pathToFileUri(absolutePath) {
      // Shared with the Monaco workbench `file` surface so on-disk documents
      // and their materialised counterparts share byte-identical URIs.
      return pathToFileUri(absolutePath)
    },
  }
}
