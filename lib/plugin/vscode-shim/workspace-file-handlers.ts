/**
 * Renderer side of `vscode.workspace`'s folders and files:
 *
 *   - `workspace:foldersChanged` tells each host the project folders open in
 *     the app's editors (before its extension activates, and on every
 *     change), which it serves as `workspace.workspaceFolders`;
 *   - `fs:authorize` answers the host's `workspace.fs`, which does the file
 *     work itself once told the extension holds `filesystem:read` /
 *     `filesystem:write` and the path is inside a folder (and which one);
 *   - `workspace:findFiles` walks the folders (`filesystem:read`), matching
 *     VS Code globs against each file's path inside its folder;
 *   - `workspace:createFileSystemWatcher` watches the folders
 *     (`filesystem:read`) and sends matching changes back in batches as
 *     `workspace:fileSystemEvents`.
 *
 * Limits, each reported in the extension's log rather than silently: a
 * search stops after {@link FIND_FILES_WALK_LIMIT} files per folder, files
 * the host never lists (`.env`, private keys) are never found, and file
 * changes are only seen on the desktop, where folders can be watched.
 */

import { listWorkspaceRoots, walkWorkspace } from "@/lib/files/workspace-fs"
import type { WorkspaceFsChange } from "@/lib/files/workspace-watch"
import { fileUriToPath, pathToFileUri } from "@/lib/files/path-uri"
import { listPluginPermissions } from "@/lib/plugin/core/transport"

import { listProjectWorkspaceFolders, onWorkspaceFoldersChanged } from "./lsp-workspace-manager"
import { watchRoot } from "./root-watchers"
import { registerMethod, type RpcContext } from "./rpc-dispatcher"
import { appendVscodeLog } from "./vscode-log-buffer"
import { matchesGlob, matchesGlobOrParent } from "./vscode-glob"

/** Files walked per folder for one `findFiles`. */
export const FIND_FILES_WALK_LIMIT = 50_000
/** How long watcher events gather before going to the host together. */
export const WATCH_BATCH_MS = 50
/**
 * VS Code's default `files.exclude`, applied when `findFiles` is given no
 * exclude (`null` turns excludes off).
 */
export const DEFAULT_FILE_EXCLUDES = [
  "**/.git",
  "**/.svn",
  "**/.hg",
  "**/CVS",
  "**/.DS_Store",
  "**/Thumbs.db",
]

export interface Folder {
  uri: string
  name: string
  /** Absolute path, `/`-separated, no trailing slash. */
  path: string
}

export interface VscodeWorkspaceFilesDependencies {
  folders(): Folder[]
  onFoldersChanged(listener: () => void): () => void
  /** Other directories the host browses (the active desktop project's). */
  extraRoots(): Promise<string[]>
  permissions(pluginId: string): Promise<readonly string[]>
  walk(
    root: string,
    options: { relPath?: string; maxEntries: number }
  ): Promise<{ files: string[]; truncated: boolean; skippedSensitive: number }>
  watch(root: string, listener: (change: WorkspaceFsChange) => void): () => void
  sendToHost(pluginId: string, method: string, payload: unknown): Promise<unknown>
  hosts(): string[]
}

export function createVscodeWorkspaceFilesDependencies(input: {
  sendToHost: VscodeWorkspaceFilesDependencies["sendToHost"]
  hosts: VscodeWorkspaceFilesDependencies["hosts"]
}): VscodeWorkspaceFilesDependencies {
  return {
    ...input,
    folders: listProjectWorkspaceFolders,
    onFoldersChanged: onWorkspaceFoldersChanged,
    extraRoots: async () => (await listWorkspaceRoots()).map((root) => root.path),
    permissions: (pluginId) => listPluginPermissions(pluginId),
    walk: async (root, options) => {
      const result = await walkWorkspace(root, {
        ...(options.relPath ? { relPath: options.relPath } : {}),
        // `findFiles` does not apply ignore files, as in VS Code.
        includeIgnored: true,
        maxEntries: options.maxEntries,
      })
      return {
        files: result.entries.filter((entry) => !entry.isDir).map((entry) => entry.absolutePath),
        truncated: result.truncated,
        skippedSensitive: result.skippedSensitive,
      }
    },
    watch: watchRoot,
  }
}

let deps: VscodeWorkspaceFilesDependencies | null = null
let unsubscribeFolders: (() => void) | null = null

interface Watcher {
  pluginId: string
  handle: string
  /** Absolute base the pattern is relative to; none for a string pattern. */
  base: string | null
  pattern: string
  ignore: { create: boolean; change: boolean; delete: boolean }
  /** Folder path → its unsubscribe. */
  roots: Map<string, () => void>
  pending: Map<string, { kind: "create" | "change" | "delete"; uri: string }>
  timer: ReturnType<typeof setTimeout> | null
}
const watchers = new Map<string, Watcher>()

const normalize = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "")

function within(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`)
}

function requireDeps(): VscodeWorkspaceFilesDependencies {
  if (!deps) throw new Error("VS Code workspace files are not available yet")
  return deps
}

function object(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("VS Code RPC payload must be an object")
  }
  return payload as Record<string, unknown>
}

function owned(payload: unknown, context: RpcContext): Record<string, unknown> {
  const value = object(payload)
  if (value.extensionId !== undefined && value.extensionId !== context.pluginId) {
    throw new Error(
      `VS Code RPC extension ownership mismatch: ${String(value.extensionId)} != ${context.pluginId}`
    )
  }
  return value
}

async function requirePermission(pluginId: string, permission: string): Promise<void> {
  if (!(await requireDeps().permissions(pluginId)).includes(permission)) {
    throw new Error(`VS Code extension ${pluginId} requires permission ${permission}`)
  }
}

function log(pluginId: string, level: "info" | "warn", kind: string, message: string): void {
  appendVscodeLog(pluginId, { level, kind, message })
}

/** A wire glob: `{ base?: uri, pattern }`. */
function readGlob(value: unknown, field: string): { base: string | null; pattern: string } {
  const glob = object(value)
  if (typeof glob.pattern !== "string") throw new Error(`${field} requires a pattern`)
  if (glob.base === undefined) return { base: null, pattern: glob.pattern }
  if (typeof glob.base !== "string") throw new Error(`${field}.base must be a URI`)
  const path = fileUriToPath(glob.base)
  if (!path) throw new Error(`${field}.base must be a file URI, not ${glob.base}`)
  return { base: normalize(path), pattern: glob.pattern }
}

function foldersPayload(): { folders: Array<{ uri: string; name: string }> } {
  return {
    folders: requireDeps()
      .folders()
      .map(({ uri, name }) => ({ uri, name })),
  }
}

/** Tell one host the open folders; the loader awaits this before activating. */
export async function pushWorkspaceFolders(pluginId: string): Promise<void> {
  await requireDeps().sendToHost(pluginId, "workspace:foldersChanged", foldersPayload())
}

export function configureVscodeWorkspaceFiles(next: VscodeWorkspaceFilesDependencies | null): void {
  unsubscribeFolders?.()
  unsubscribeFolders = null
  for (const watcher of [...watchers.values()]) disposeWatcher(watcher)
  deps = next
  if (!next) return
  unsubscribeFolders = next.onFoldersChanged(() => {
    const payload = foldersPayload()
    for (const pluginId of next.hosts()) {
      void next.sendToHost(pluginId, "workspace:foldersChanged", payload).catch(() => undefined)
    }
    // Watchers without a base follow the folders.
    for (const watcher of watchers.values()) syncWatcherRoots(watcher)
  })
}

// ── fs:authorize ─────────────────────────────────────────────────────────

async function authorize(
  pluginId: string,
  path: string,
  access: string
): Promise<{ root: string }> {
  if (access !== "read" && access !== "write") throw new Error(`Unknown access ${access}`)
  await requirePermission(pluginId, access === "read" ? "filesystem:read" : "filesystem:write")
  const target = normalize(path)
  const candidates = [
    ...requireDeps()
      .folders()
      .map((folder) => folder.path),
    ...(await requireDeps().extraRoots()).map(normalize),
  ]
  let best: string | null = null
  for (const root of candidates) {
    if (within(target, root) && (!best || root.length > best.length)) best = root
  }
  if (!best) throw new Error(`${path} is not inside an open workspace folder`)
  return { root: best }
}

// ── findFiles ────────────────────────────────────────────────────────────

/** Where to walk for a pattern, and what each found path is matched relative to. */
function searchPlan(
  base: string | null
): Array<{ folder: Folder; relPath?: string; matchFrom: string }> {
  const plan: Array<{ folder: Folder; relPath?: string; matchFrom: string }> = []
  for (const folder of requireDeps().folders()) {
    if (base === null) plan.push({ folder, matchFrom: folder.path })
    else if (within(folder.path, base)) plan.push({ folder, matchFrom: base })
    else if (within(base, folder.path)) {
      plan.push({ folder, relPath: base.slice(folder.path.length + 1), matchFrom: base })
    }
  }
  return plan
}

async function findFiles(
  pluginId: string,
  include: { base: string | null; pattern: string },
  exclude: { base: string | null; pattern: string } | null | undefined,
  maxResults: number | undefined
): Promise<string[]> {
  await requirePermission(pluginId, "filesystem:read")
  const results: string[] = []
  const seen = new Set<string>()
  const limit = maxResults !== undefined && maxResults > 0 ? maxResults : Number.POSITIVE_INFINITY
  for (const { folder, relPath, matchFrom } of searchPlan(include.base)) {
    if (results.length >= limit) break
    const walked = await requireDeps().walk(folder.path, {
      ...(relPath ? { relPath } : {}),
      maxEntries: FIND_FILES_WALK_LIMIT,
    })
    if (walked.truncated) {
      log(
        pluginId,
        "warn",
        "workspace-find-files",
        `workspace.findFiles looked at the first ${FIND_FILES_WALK_LIMIT} files of ${folder.path} only`
      )
    }
    if (walked.skippedSensitive > 0) {
      log(
        pluginId,
        "info",
        "workspace-find-files",
        `workspace.findFiles never lists files like .env or private keys; ${walked.skippedSensitive} in ${folder.path} were left out`
      )
    }
    for (const file of walked.files) {
      if (results.length >= limit) break
      const path = normalize(file)
      if (seen.has(path) || !within(path, matchFrom) || path === matchFrom) continue
      if (!matchesGlob(include.pattern, path.slice(matchFrom.length + 1))) continue
      const inFolder = path.slice(folder.path.length + 1)
      if (exclude === undefined) {
        if (DEFAULT_FILE_EXCLUDES.some((glob) => matchesGlobOrParent(glob, inFolder))) continue
      } else if (exclude !== null) {
        const from = exclude.base ?? folder.path
        if (
          within(path, from) &&
          matchesGlobOrParent(exclude.pattern, path.slice(from.length + 1))
        ) {
          continue
        }
      }
      seen.add(path)
      results.push(pathToFileUri(path))
    }
  }
  return results
}

// ── File watchers ────────────────────────────────────────────────────────

function watcherKey(pluginId: string, handle: string): string {
  return `${pluginId}\u0000${handle}`
}

/** The folders a watcher needs watched now. */
function rootsFor(watcher: Watcher): string[] {
  return requireDeps()
    .folders()
    .map((folder) => folder.path)
    .filter(
      (root) => watcher.base === null || within(root, watcher.base) || within(watcher.base, root)
    )
}

function syncWatcherRoots(watcher: Watcher): void {
  const wanted = new Set(rootsFor(watcher))
  for (const [root, stop] of watcher.roots) {
    if (!wanted.has(root)) {
      stop()
      watcher.roots.delete(root)
    }
  }
  for (const root of wanted) {
    if (watcher.roots.has(root)) continue
    watcher.roots.set(
      root,
      requireDeps().watch(root, (change) => onChange(watcher, change))
    )
  }
}

function onChange(watcher: Watcher, change: WorkspaceFsChange): void {
  const path = normalize(change.path)
  const kind = change.kind === "create" ? "create" : change.kind === "delete" ? "delete" : "change"
  if (watcher.ignore[kind]) return
  if (watcher.base === null) {
    // A string pattern is matched against the whole path, as in VS Code.
    if (!matchesGlob(watcher.pattern, path)) return
  } else {
    if (!within(path, watcher.base) || path === watcher.base) return
    if (!matchesGlob(watcher.pattern, path.slice(watcher.base.length + 1))) return
  }
  const uri = pathToFileUri(path)
  watcher.pending.set(`${kind}\u0000${uri}`, { kind, uri })
  if (watcher.timer) return
  watcher.timer = setTimeout(() => flush(watcher), WATCH_BATCH_MS)
}

function flush(watcher: Watcher): void {
  watcher.timer = null
  if (watcher.pending.size === 0 || !deps) return
  const events = [...watcher.pending.values()]
  watcher.pending.clear()
  void deps
    .sendToHost(watcher.pluginId, "workspace:fileSystemEvents", { handle: watcher.handle, events })
    .catch(() => undefined)
}

function disposeWatcher(watcher: Watcher): void {
  for (const stop of watcher.roots.values()) stop()
  watcher.roots.clear()
  if (watcher.timer) clearTimeout(watcher.timer)
  watchers.delete(watcherKey(watcher.pluginId, watcher.handle))
}

async function createWatcher(pluginId: string, value: Record<string, unknown>): Promise<boolean> {
  const handle = value.handle
  if (typeof handle !== "string" || !handle) throw new Error("A watcher needs a handle")
  try {
    await requirePermission(pluginId, "filesystem:read")
  } catch (error) {
    log(
      pluginId,
      "warn",
      "workspace-watcher",
      `A file watcher was not started: ${error instanceof Error ? error.message : String(error)}`
    )
    return false
  }
  const glob = readGlob(value.pattern, "pattern")
  const key = watcherKey(pluginId, handle)
  const existing = watchers.get(key)
  if (existing) disposeWatcher(existing)
  const watcher: Watcher = {
    pluginId,
    handle,
    base: glob.base,
    pattern: glob.pattern,
    ignore: {
      create: value.ignoreCreateEvents === true,
      change: value.ignoreChangeEvents === true,
      delete: value.ignoreDeleteEvents === true,
    },
    roots: new Map(),
    pending: new Map(),
    timer: null,
  }
  watchers.set(key, watcher)
  syncWatcherRoots(watcher)
  if (glob.base !== null && watcher.roots.size === 0) {
    log(
      pluginId,
      "warn",
      "workspace-watcher",
      `A file watcher on ${glob.base} sees nothing: it is outside every open workspace folder`
    )
  }
  return true
}

export function installVscodeWorkspaceFileHandlers(): Array<() => void> {
  const disposers: Array<() => void> = []
  const on = (method: string, handler: Parameters<typeof registerMethod>[1]) =>
    disposers.push(registerMethod(method, handler))

  on("fs:authorize", async (payload, context) => {
    const value = owned(payload, context)
    if (typeof value.path !== "string" || !value.path) throw new Error("fs:authorize needs a path")
    return authorize(context.pluginId, value.path, String(value.access))
  })

  on("workspace:findFiles", async (payload, context) => {
    const value = owned(payload, context)
    const include = readGlob(value.include, "include")
    const exclude =
      value.exclude === undefined
        ? undefined
        : value.exclude === null
          ? null
          : readGlob(value.exclude, "exclude")
    const maxResults = typeof value.maxResults === "number" ? value.maxResults : undefined
    return findFiles(context.pluginId, include, exclude, maxResults)
  })

  on("workspace:createFileSystemWatcher", async (payload, context) => {
    return { watching: await createWatcher(context.pluginId, owned(payload, context)) }
  })

  on("workspace:disposeFileSystemWatcher", (payload, context) => {
    const value = owned(payload, context)
    const watcher = watchers.get(watcherKey(context.pluginId, String(value.handle)))
    if (watcher) disposeWatcher(watcher)
    return null
  })

  return disposers
}

/** Stop a stopped extension's watchers. */
export function clearVscodeWorkspaceFilesForPlugin(pluginId: string): void {
  for (const watcher of [...watchers.values()]) {
    if (watcher.pluginId === pluginId) disposeWatcher(watcher)
  }
}

/** The watchers running now, for tests and diagnostics. */
export function activeWatcherHandles(pluginId: string): string[] {
  return [...watchers.values()]
    .filter((watcher) => watcher.pluginId === pluginId)
    .map((watcher) => watcher.handle)
}

export function __resetVscodeWorkspaceFilesForTesting(): void {
  configureVscodeWorkspaceFiles(null)
}
