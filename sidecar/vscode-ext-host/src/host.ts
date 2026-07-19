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

import { ErrorCode, RpcConnection, type RpcError } from "./rpc"
import { installRequireHook, setExtensionResolver, setGrantedModules } from "./require-hook"
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
  globalStorageUri: string
  storageUri: string
  logUri: string
  extensionMode: "production" | "development" | "test"
  initialGlobalState: Record<string, unknown>
  initialWorkspaceState: Record<string, unknown>
}

interface CallExtensionRequest {
  extensionId: string
  /** Method name, e.g. `provideCompletionItems`. */
  method: string
  /** Opaque token the renderer's bridge generated when the provider registered. */
  token: string
  payload: unknown
}

const ACTIVE_CONTEXTS = new Map<string, SidecarExtensionContext>()
const PROVIDER_CALLBACKS = new Map<string, (payload: unknown) => Promise<unknown> | unknown>()

const connection = new RpcConnection(process.stdin, process.stdout)

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

// Map a require() call back to an extension by walking `parent.cogniaExtensionId`.
setExtensionResolver((parent) => {
  let cur: NodeModule | null = parent
  while (cur) {
    const tagged = (cur.require as unknown as { cogniaExtensionId?: string }).cogniaExtensionId
    if (typeof tagged === "string") return tagged
    cur = cur.parent ?? null
  }
  return null
})

installRequireHook()

// Configure the vscode shim factory. The actual shim implementation lives
// in `src/vscode-shim/index.ts` — wired below.
setVscodeShimFactory((extensionId) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createVscodeShim } = require("./vscode-shim") as typeof import("./vscode-shim")
  return createVscodeShim({ extensionId, connection, registerProviderCallback })
})

function registerProviderCallback(
  token: string,
  cb: (payload: unknown) => Promise<unknown> | unknown
): () => void {
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
  const context = buildContext(req)
  ACTIVE_CONTEXTS.set(req.extensionId, context)
  const exports = await activateExtension(req.extensionId, context)
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
  return { ok: true }
})

connection.onRequest("extension:unload", async (params) => {
  const { extensionId } = params as { extensionId: string }
  unloadExtension(extensionId)
  ACTIVE_CONTEXTS.delete(extensionId)
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
  const result = await cb(req.payload)
  return result ?? null
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

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function buildContext(req: ActivateRequest): SidecarExtensionContext {
  const globalState = makeKvStore(req.initialGlobalState)
  const workspaceState = makeKvStore(req.initialWorkspaceState)
  const extensionPath = req.extensionPath
  return {
    subscriptions: [] as Disposable[],
    globalState,
    workspaceState,
    secrets: makeSecretsStore(req.extensionId, connection),
    extensionUri: `file://${req.extensionId}`,
    extensionPath,
    globalStorageUri: req.globalStorageUri,
    storageUri: req.storageUri,
    logUri: req.logUri,
    extensionMode: req.extensionMode,
    extension: {
      id: req.extensionId,
      extensionPath: req.extensionId,
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
      canSendRequest: () => "limited",
      onDidChange: () => ({ dispose: () => {} }),
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

function makeKvStore(initial: Record<string, unknown>): SidecarExtensionContext["globalState"] {
  const map = new Map(Object.entries(initial))
  return {
    get<T>(key: string): T | undefined {
      return map.get(key) as T | undefined
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) {
        map.delete(key)
      } else {
        map.set(key, value)
      }
    },
    keys(): readonly string[] {
      return [...map.keys()]
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
  process.exit(0)
})
