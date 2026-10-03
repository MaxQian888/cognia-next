/**
 * Sidecar entry point.
 *
 * Spawned by Tauri (`src-tauri/src/plugin_api/vscode/host.rs`) as a child
 * process. Reads JSON-RPC frames on stdin, writes responses on stdout.
 * stderr is reserved for diagnostic logs the renderer captures verbatim.
 *
 * The host plays four roles:
 *   1. Manages each loaded extension's VM context (via
 *      `extension-runner.ts`).
 *   2. Forwards `vscode.*` RPC calls from the extension back to the
 *      renderer via the JSON-RPC connection.
 *   3. Enforces the runtime permission gate (via `require-hook.ts`) on
 *      sensitive Node modules.
 *   4. Tracks every command / view / language-provider registration so the
 *      renderer can rebuild its UI state when the sidecar reconnects.
 *
 * No Tauri APIs are imported here — the sidecar runs as a vanilla Node
 * process. This makes it trivial to test under Node's `--test` runner.
 */

import * as nodePath from "node:path"

import { ErrorCode, RpcConnection, type RpcError } from "./rpc"
import {
  createExtensionResolver,
  installRequireHook,
  setExtensionResolver,
  setGrantedModules,
} from "./require-hook"
import { ExtensionMode } from "./vscode-shim/api-types"
import { DocumentStore, type EditOutcome } from "./vscode-shim/documents"
import { ConfigurationStore } from "./vscode-shim/configuration"
import { ExtensionRegistry } from "./vscode-shim/extensions"
import { TerminalRegistry } from "./vscode-shim/terminal"
import { WebviewRegistry } from "./vscode-shim/webviews"
import { LanguageModels } from "./vscode-shim/lm"
import { installEnvProxy } from "./network"
import { WorkspaceFolders } from "./vscode-shim/workspace-folders"
import type { OwnedPaths } from "./vscode-shim/workspace-fs"
import { CancellationTokenSource, Uri, type CancellationToken } from "./vscode-shim/types"
import {
  activateExtension,
  deactivateExtension,
  loadExtension,
  setVscodeShimFactory,
  unloadExtension,
  type SidecarExtensionContext,
  type Disposable,
} from "./extension-runner"

interface LoadRequest {
  extensionId: string
  extensionPath: string
  main: string
  bundleFormat: "cjs" | "esm" | "mixed"
  grantedModules: string[]
}

interface ActivateRequest {
  extensionId: string
  extensionPath: string
  /** Plain filesystem paths; the host builds the `Uri`s. */
  globalStoragePath: string
  /** Absent when no workspace folder is open, as in VS Code. */
  storagePath: string | null
  logPath: string
  extensionMode: "production" | "development" | "test"
  initialGlobalState: Record<string, unknown>
  initialWorkspaceState: Record<string, unknown>
}

interface CallExtensionRequest {
  extensionId: string
  /** Provider method, e.g. `provideCompletionItems`. */
  method: string
  /** The token the shim gave the provider when it registered. */
  token: string
  /** Names the call for `extension:cancel`. */
  callId?: string
  payload: unknown
}

/** What `extension:call` passes a callback besides the payload. */
export interface ProviderCall {
  method: string
  cancellation: CancellationToken
}

type ProviderCallback = (payload: unknown, call: ProviderCall) => Promise<unknown> | unknown

/** The sidecar package itself: its own code and dependencies are never an extension's. */
const HOST_PACKAGE_ROOT = nodePath.resolve(__dirname, "..")
/** Extension install root → extension id, registered at `extension:load`. */
const EXTENSION_ROOTS = new Map<string, string>()

const ACTIVE_CONTEXTS = new Map<string, SidecarExtensionContext>()
const PROVIDER_CALLBACKS = new Map<string, ProviderCallback>()
/** Calls in flight, by call id, so the renderer can cancel them. */
const PENDING_CALLS = new Map<string, CancellationTokenSource>()

const connection = new RpcConnection(process.stdin, process.stdout)

// An extension's stray rejection or throw is its bug, not the host's: log it
// (stderr reaches the plugin's log stream) and keep serving, as VS Code's
// extension host does. Node would otherwise exit, and the renderer would
// restart the host into the same error.
process.on("unhandledRejection", (reason) => {
  process.stderr.write(
    `[extension-host] Unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`
  )
})
process.on("uncaughtException", (error) => {
  process.stderr.write(`[extension-host] Uncaught exception: ${error.stack ?? error.message}\n`)
})

/**
 * The open documents and editors every extension in this host sees. Saving
 * goes to the renderer, which owns the text.
 */
const DOCUMENTS = new DocumentStore(
  (document) =>
    connection.sendRequest<boolean>("workspace:saveTextDocument", { uri: document.uri.toString() }),
  {
    edit: (editorId, version, edits, options) =>
      connection.sendRequest<EditOutcome>("window:editorEdit", {
        editorId,
        version,
        edits,
        options,
      }),
    insertSnippet: (editorId, version, snippet, ranges, options) =>
      connection.sendRequest<EditOutcome>("window:editorInsertSnippet", {
        editorId,
        version,
        snippet,
        ranges,
        options,
      }),
    setDecorations: (editorId, key, decorations) =>
      void connection.sendNotification("window:setDecorations", { editorId, key, decorations }),
    revealRange: (editorId, range, revealType) =>
      void connection.sendNotification("window:revealRange", { editorId, range, revealType }),
    setSelections: (editorId, selections) =>
      void connection.sendNotification("window:setSelections", { editorId, selections }),
    setOptions: (editorId, options) =>
      void connection.sendNotification("window:setEditorOptions", { editorId, options }),
  }
)
DOCUMENTS.attach(connection)

/** The open workspace folders, and the routing of file-watcher events. */
const FOLDERS = new WorkspaceFolders()
FOLDERS.attach(connection)

/** The settings the renderer reports, plus the extension's own declared defaults. */
const CONFIGURATION = new ConfigurationStore()
CONFIGURATION.attach(connection)

/** The installed VS Code extensions, and the exports of this host's own. */
const EXTENSIONS = new ExtensionRegistry()
EXTENSIONS.attach(connection)
const TERMINALS = new TerminalRegistry()
TERMINALS.attach(connection)
const WEBVIEWS = new WebviewRegistry()
WEBVIEWS.attach(connection)
const LANGUAGE_MODELS = new LanguageModels()
LANGUAGE_MODELS.attach(connection)

/** Per extension, the directories it owns (install, storage, logs). */
const OWNED_PATHS = new Map<string, OwnedPaths>()

// Phase B of the LSP reuse work — see
// `lib/plugin/lsp/lsp-registry.ts` and
// `~/.claude/plans/vscode-lsp-mighty-robin.md`. The service is wired
// lazily so the existing `extension:*` flow stays untouched: it's
// only instantiated the first time the renderer sends an `lsp:*`
// frame.
let lspService: import("./lsp-service").LspService | null = null
function ensureLspService(): import("./lsp-service").LspService {
  if (lspService) return lspService
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { LspService } = require("./lsp-service") as typeof import("./lsp-service")
  lspService = new LspService(
    (method, params) => {
      connection.sendNotification(method, params)
    },
    {
      info: (msg, ctx) =>
        process.stderr.write(`[lsp-service] ${msg} ${JSON.stringify(ctx ?? {})}\n`),
      warn: (msg, ctx) =>
        process.stderr.write(`[lsp-service] WARN ${msg} ${JSON.stringify(ctx ?? {})}\n`),
      error: (msg, ctx) =>
        process.stderr.write(`[lsp-service] ERROR ${msg} ${JSON.stringify(ctx ?? {})}\n`),
    }
  )
  return lspService
}

let protocolService: import("./protocol-process-service").ProtocolProcessService | null = null
function ensureProtocolService(): import("./protocol-process-service").ProtocolProcessService {
  if (protocolService) return protocolService
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ProtocolProcessService } =
    require("./protocol-process-service") as typeof import("./protocol-process-service")
  protocolService = new ProtocolProcessService((method, params) => {
    connection.sendNotification(method, params)
  })
  return protocolService
}

// Map a require() call back to an extension by WHERE the requiring module
// lives. The extension's main bundle runs with a `createRequire(mainPath)`
// require, whose parent module is a fresh one; a tag on it does not survive,
// which once left every `require("vscode")` unattributed and every
// sensitive-module gate open. File location cannot be lost that way.
setExtensionResolver(
  createExtensionResolver({
    hostRoot: HOST_PACKAGE_ROOT,
    roots: EXTENSION_ROOTS,
    dedicatedExtensionId: process.env.COGNIA_VSCODE_EXTENSION_ID ?? null,
  })
)

installRequireHook()

// Extensions' `fetch`, `WebSocket` and `http(s)` go through the user's proxy.
installEnvProxy()

// Configure the vscode shim factory. The actual shim implementation lives
// in `src/vscode-shim/index.ts` — wired below.
setVscodeShimFactory((extensionId) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createVscodeShim } = require("./vscode-shim") as typeof import("./vscode-shim")
  return createVscodeShim({
    extensionId,
    connection,
    documents: DOCUMENTS,
    folders: FOLDERS,
    configuration: CONFIGURATION,
    extensions: EXTENSIONS,
    terminals: TERMINALS,
    webviews: WEBVIEWS,
    languageModels: LANGUAGE_MODELS,
    ownedPaths: () => OWNED_PATHS.get(extensionId) ?? { readOnly: [], readWrite: [] },
    registerProviderCallback,
  })
})

function registerProviderCallback(token: string, cb: ProviderCallback): () => void {
  PROVIDER_CALLBACKS.set(token, cb)
  return () => {
    PROVIDER_CALLBACKS.delete(token)
  }
}

// ────────────────────────────────────────────────────────────────────────
// RPC request handlers (renderer → sidecar)
// ────────────────────────────────────────────────────────────────────────

connection.onRequest("extension:load", async (params) => {
  const req = params as LoadRequest
  setGrantedModules(req.extensionId, req.grantedModules ?? [])
  EXTENSION_ROOTS.set(nodePath.resolve(req.extensionPath), req.extensionId)
  OWNED_PATHS.set(req.extensionId, { readOnly: [req.extensionPath], readWrite: [] })
  CONFIGURATION.loadOwnDefaults(req.extensionPath)
  await loadExtension({
    extensionId: req.extensionId,
    extensionPath: req.extensionPath,
    main: req.main,
    bundleFormat: req.bundleFormat,
  })
  return { ok: true }
})

connection.onRequest("extension:activate", async (params) => {
  const req = params as ActivateRequest
  OWNED_PATHS.set(req.extensionId, {
    readOnly: [req.extensionPath],
    readWrite: [req.globalStoragePath, ...(req.storagePath ? [req.storagePath] : []), req.logPath],
  })
  const context = buildContext(req)
  ACTIVE_CONTEXTS.set(req.extensionId, context)
  const exports = await activateExtension(req.extensionId, context)
  EXTENSIONS.setExports(req.extensionId, exports)
  return {
    sidecarPid: process.pid,
    registeredCommands: [] as string[],
    registeredWebviewViews: [] as string[],
    registeredLanguageProviders: [] as string[],
    exportsSerializable: serializeExports(exports),
  }
})

connection.onRequest("extension:deactivate", async (params) => {
  const { extensionId } = params as { extensionId: string }
  await deactivateExtension(extensionId)
  ACTIVE_CONTEXTS.delete(extensionId)
  EXTENSIONS.clearExports(extensionId)
  TERMINALS.closeAll(extensionId)
  WEBVIEWS.closeAll(extensionId)
  return { ok: true }
})

connection.onRequest("extension:unload", async (params) => {
  const { extensionId } = params as { extensionId: string }
  unloadExtension(extensionId)
  ACTIVE_CONTEXTS.delete(extensionId)
  for (const [root, id] of [...EXTENSION_ROOTS]) {
    if (id === extensionId) EXTENSION_ROOTS.delete(root)
  }
  return { ok: true }
})

connection.onRequest("extension:call", async (params) => {
  const req = params as CallExtensionRequest
  const cb = PROVIDER_CALLBACKS.get(req.token)
  if (!cb) {
    throw {
      code: ErrorCode.MethodNotFound,
      message: `No provider callback registered for token ${req.token}`,
    } as RpcError
  }
  const source = new CancellationTokenSource()
  if (req.callId) PENDING_CALLS.set(req.callId, source)
  try {
    const result = await cb(req.payload, { method: req.method, cancellation: source.token })
    return result ?? null
  } finally {
    if (req.callId) PENDING_CALLS.delete(req.callId)
    source.dispose()
  }
})

connection.onRequest("extension:cancel", (params) => {
  PENDING_CALLS.get((params as { callId: string }).callId)?.cancel()
  return null
})

// ────────────────────────────────────────────────────────────────────────
// Phase B — standalone LSP RPC surface (lsp:*). See `lsp-service.ts`.
// ────────────────────────────────────────────────────────────────────────

connection.onRequest("lsp:start", async (params) => {
  return ensureLspService().start(
    params as Parameters<
      typeof ensureLspService extends () => infer S
        ? S extends { start: (p: infer P) => unknown }
          ? (p: P) => unknown
          : never
        : never
    >[0]
  )
})

connection.onRequest("lsp:stop", async (params) => {
  const p = params as { ownerId: string; serverId: string }
  return ensureLspService().stop(p.ownerId, p.serverId)
})

connection.onRequest("lsp:didOpen", async (params) => {
  ensureLspService().didOpen(params as Parameters<import("./lsp-service").LspService["didOpen"]>[0])
  return { ok: true }
})

connection.onRequest("lsp:didChange", async (params) => {
  ensureLspService().didChange(
    params as Parameters<import("./lsp-service").LspService["didChange"]>[0]
  )
  return { ok: true }
})

connection.onRequest("lsp:didClose", async (params) => {
  ensureLspService().didClose(
    params as Parameters<import("./lsp-service").LspService["didClose"]>[0]
  )
  return { ok: true }
})

connection.onRequest("lsp:request", async (params) => {
  return ensureLspService().request(
    params as Parameters<import("./lsp-service").LspService["request"]>[0]
  )
})

connection.onRequest("lsp:cancel", async (params) => {
  const input = params as { ownerId: string; serverId: string; requestId: string }
  return { cancelled: ensureLspService().cancel(input.ownerId, input.serverId, input.requestId) }
})

connection.onRequest("lsp:serverResponse", async (params) => {
  return ensureLspService().serverResponse(
    params as Parameters<import("./lsp-service").LspService["serverResponse"]>[0]
  )
})

connection.onRequest("lsp:clientNotification", async (params) => {
  return ensureLspService().clientNotification(
    params as Parameters<import("./lsp-service").LspService["clientNotification"]>[0]
  )
})

connection.onRequest("lsp:list", async () => {
  return ensureLspService().list()
})

connection.onRequest("lsp:status", async () => {
  return ensureLspService().status()
})

connection.onRequest("lsp:logs", async (params) => {
  return ensureLspService().logs(
    (params ?? {}) as Parameters<import("./lsp-service").LspService["logs"]>[0]
  )
})

connection.onRequest("lsp:detect", async (params) => {
  return ensureLspService().detect(
    params as Parameters<import("./lsp-service").LspService["detect"]>[0]
  )
})

connection.onRequest("lsp:install", async (params) => {
  return ensureLspService().install(
    params as Parameters<import("./lsp-service").LspService["install"]>[0]
  )
})

connection.onRequest("protocol:start", async (params) => {
  return ensureProtocolService().start(
    params as Parameters<import("./protocol-process-service").ProtocolProcessService["start"]>[0]
  )
})

connection.onRequest("protocol:request", async (params) => {
  return ensureProtocolService().request(
    params as Parameters<import("./protocol-process-service").ProtocolProcessService["request"]>[0]
  )
})

connection.onRequest("protocol:cancel", async (params) => {
  const input = params as { ownerId: string; serverId: string; requestId: string }
  return {
    cancelled: ensureProtocolService().cancel(input.ownerId, input.serverId, input.requestId),
  }
})

connection.onRequest("protocol:stop", async (params) => {
  const input = params as { ownerId: string; serverId: string }
  return ensureProtocolService().stop(input.ownerId, input.serverId)
})

connection.onRequest("protocol:status", async () => {
  return ensureProtocolService().status()
})

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

const EXTENSION_MODES = {
  production: ExtensionMode.Production,
  development: ExtensionMode.Development,
  test: ExtensionMode.Test,
} as const

function buildContext(req: ActivateRequest): SidecarExtensionContext {
  const globalState = makeKvStore(req.extensionId, "global", req.initialGlobalState)
  const workspaceState = makeKvStore(req.extensionId, "workspace", req.initialWorkspaceState)
  const extensionPath = req.extensionPath
  const extensionUri = Uri.file(extensionPath)
  return {
    subscriptions: [] as Disposable[],
    globalState,
    workspaceState,
    secrets: makeSecretsStore(req.extensionId, connection),
    extensionUri,
    extensionPath,
    globalStorageUri: Uri.file(req.globalStoragePath),
    globalStoragePath: req.globalStoragePath,
    storageUri: req.storagePath ? Uri.file(req.storagePath) : undefined,
    storagePath: req.storagePath ?? undefined,
    logUri: Uri.file(req.logPath),
    logPath: req.logPath,
    extensionMode: EXTENSION_MODES[req.extensionMode] ?? ExtensionMode.Production,
    // Replaced with the real manifest by `activateExtension`.
    extension: {
      id: req.extensionId,
      extensionPath,
      extensionUri,
      isActive: true,
      packageJSON: {},
    },
    asAbsolutePath: (relativePath: string) => {
      // path.resolve flattens leading `./` and joins absolute paths
      // correctly. The sidecar runs in Node so a synchronous import is
      // safe; we avoid a top-level import to keep the build size lean.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const nodePath = require("node:path") as typeof import("node:path")
      return nodePath.resolve(extensionPath, relativePath)
    },
    environmentVariableCollection: makeEnvironmentVariableCollection(),
    languageModelAccessInformation: {
      canSendRequest: (chat) => LANGUAGE_MODELS.canSendRequest(chat),
      onDidChange: LANGUAGE_MODELS.changed.event,
    },
  }
}

function makeEnvironmentVariableCollection() {
  type Mutator = { type: "replace" | "append" | "prepend"; value: string }
  const map = new Map<string, Mutator>()
  const collection = {
    persistent: false,
    description: undefined as string | undefined,
    replace(variable: string, value: string) {
      map.set(variable, { type: "replace", value })
    },
    append(variable: string, value: string) {
      map.set(variable, { type: "append", value })
    },
    prepend(variable: string, value: string) {
      map.set(variable, { type: "prepend", value })
    },
    get(variable: string): Mutator | undefined {
      return map.get(variable)
    },
    forEach(callback: (variable: string, mutator: Mutator) => void) {
      for (const [variable, mutator] of map) {
        callback(variable, mutator)
      }
    },
    delete(variable: string) {
      map.delete(variable)
    },
    clear() {
      map.clear()
    },
    apply(env: Record<string, string | undefined>): Record<string, string> {
      const result: Record<string, string> = Object.fromEntries(
        Object.entries(env).filter(([, v]) => v !== undefined) as Array<[string, string]>
      )
      for (const [variable, mutator] of map) {
        const existing = result[variable] ?? ""
        if (mutator.type === "replace") result[variable] = mutator.value
        else if (mutator.type === "append") result[variable] = existing + mutator.value
        else if (mutator.type === "prepend") result[variable] = mutator.value + existing
      }
      return result
    },
  }
  return collection
}

/**
 * A `Memento`. Every write is also sent to the Rust host (`memento:write`),
 * which persists it in the extension's state directory, outside its install
 * directory, so it survives a restart and an update. The host intercepts the
 * notification; the renderer never sees it.
 */
function makeKvStore(
  extensionId: string,
  scope: "global" | "workspace",
  initial: Record<string, unknown>
): SidecarExtensionContext["globalState"] {
  const map = new Map(Object.entries(initial ?? {}))
  return {
    get<T>(key: string, defaultValue?: T): T | undefined {
      return map.has(key) ? (map.get(key) as T) : defaultValue
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) {
        map.delete(key)
      } else {
        // A Memento holds JSON: what does not survive a round trip is not kept.
        map.set(key, JSON.parse(JSON.stringify(value)) as unknown)
      }
      connection.sendNotification("memento:write", {
        extensionId,
        scope,
        key,
        value: value === undefined ? null : map.get(key),
        deleted: value === undefined,
      })
    },
    keys(): readonly string[] {
      return [...map.keys()]
    },
    setKeysForSync(): void {
      // Settings Sync does not exist here; nothing to mark.
    },
  }
}

function makeSecretsStore(
  extensionId: string,
  conn: RpcConnection
): SidecarExtensionContext["secrets"] {
  return {
    async get(key: string): Promise<string | undefined> {
      return conn.sendRequest<string | undefined>("secrets:get", { extensionId, key })
    },
    async store(key: string, value: string): Promise<void> {
      await conn.sendRequest<unknown>("secrets:store", { extensionId, key, value })
    },
    async delete(key: string): Promise<void> {
      await conn.sendRequest<unknown>("secrets:delete", { extensionId, key })
    },
  }
}

function serializeExports(exports: unknown): unknown {
  // Best-effort: strip functions (they can't cross the JSON boundary).
  try {
    return JSON.parse(
      JSON.stringify(exports, (_key, value) => {
        if (typeof value === "function") return "[Function]"
        return value
      })
    ) as unknown
  } catch {
    return null
  }
}

// Tell the renderer we're ready.
connection.sendNotification("sidecar:ready", { pid: process.pid })

process.on("SIGTERM", () => {
  // Best-effort: clean up every active extension before exit.
  for (const extensionId of ACTIVE_CONTEXTS.keys()) {
    try {
      void deactivateExtension(extensionId)
      unloadExtension(extensionId)
    } catch {
      /* swallow */
    }
  }
  // Phase B — also tear down any LSP clients before exit so child
  // processes don't outlive the sidecar.
  if (lspService) {
    void lspService.stopAll()
  }
  if (protocolService) {
    void protocolService.stopAll()
  }
  process.exit(0)
})
