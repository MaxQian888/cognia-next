/**
 * Per-extension VM context manager.
 *
 * One sidecar hosts every VS Code extension. Each extension gets its own
 * `vm.createContext` so per-extension globals (`require`, `module`,
 * `exports`, `__dirname`, `__filename`, `process`) are isolated. The
 * context proxies the host's `require` through `require-hook.ts` so
 * `require("vscode")` lands on the shim and sensitive Node built-ins
 * trigger the runtime permission gate.
 *
 * Lifecycle:
 *   1. `loadExtension(req)` — read the main bundle, compile inside a fresh
 *      Context, capture `module.exports.activate` / `.deactivate`.
 *   2. `activateExtension(extId, context)` — call `activate(context)` with
 *      the cognia-supplied ExtensionContext. Track subscriptions for later
 *      disposal.
 *   3. `deactivateExtension(extId)` — call `deactivate()` (if exported)
 *      and dispose every subscription.
 *   4. `unloadExtension(extId)` — drop the VM context so V8 can GC it.
 *
 * Crash isolation: errors thrown inside an extension's activate/deactivate
 * propagate to the caller but never bring down the sidecar process.
 *
 * ESM support: when the bundle's `type` is `"esm"`, we load via
 * `vm.SourceTextModule` (requires `--experimental-vm-modules`). When CJS
 * or unknown, we use `vm.Script` (default).
 */

import * as vm from "node:vm"
import * as fs from "node:fs"
import * as path from "node:path"
import { isModuleGranted, registerVscodeShim, unregisterVscodeShim } from "./require-hook"
import type { Uri } from "./vscode-shim/types"

export interface ExtensionLoadRequest {
  extensionId: string
  extensionPath: string
  /** Relative path to the main bundle from `extensionPath`. */
  main: string
  /** Bundle format. Determines whether we use vm.Script or SourceTextModule. */
  bundleFormat: "cjs" | "esm" | "mixed"
}

export interface SidecarExtensionContext {
  subscriptions: Disposable[]
  globalState: KvStore
  workspaceState: KvStore
  secrets: SecretsStore
  extensionUri: Uri
  extensionPath: string
  globalStorageUri: Uri
  globalStoragePath: string
  /** Undefined when no workspace folder is open. */
  storageUri: Uri | undefined
  storagePath: string | undefined
  logUri: Uri
  logPath: string
  /** `ExtensionMode`: Production 1, Development 2, Test 3. */
  extensionMode: number
  extension: {
    id: string
    extensionPath: string
    extensionUri: Uri
    isActive: boolean
    packageJSON: Record<string, unknown>
    exports?: unknown
  }
  /**
   * Resolves a relative path against `extensionPath`. Mirrors VS Code's
   * `ExtensionContext.asAbsolutePath`. Returns the absolute path on disk
   * the extension can pass to `fs.readFile`, `path.join`, etc.
   */
  asAbsolutePath: (relativePath: string) => string
  /**
   * Environment variable collection — VS Code lets extensions append /
   * prepend / replace env vars in spawned terminals. cognia tracks the
   * mutations and applies them when `window.createTerminal` runs.
   */
  environmentVariableCollection: EnvironmentVariableCollection
  /**
   * Whether the extension may send requests to a language model: `true` or
   * `false` for a model `lm.selectChatModels` returned (it holds `ai:chat` or
   * not), `undefined` for one the host has not been told about. Changes when
   * the app's models do.
   */
  languageModelAccessInformation: LanguageModelAccessInformation
}

export interface EnvironmentVariableMutator {
  type: "replace" | "append" | "prepend"
  value: string
}

export interface EnvironmentVariableCollection {
  persistent: boolean
  description?: string
  replace(variable: string, value: string): void
  append(variable: string, value: string): void
  prepend(variable: string, value: string): void
  get(variable: string): EnvironmentVariableMutator | undefined
  forEach(callback: (variable: string, mutator: EnvironmentVariableMutator) => void): void
  delete(variable: string): void
  clear(): void
  /** Project the current mutations onto a starting env map. */
  apply(env: Record<string, string | undefined>): Record<string, string>
}

export interface LanguageModelAccessInformation {
  canSendRequest(chat: { id?: unknown }): boolean | undefined
  onDidChange: (
    listener: () => void,
    thisArgs?: unknown,
    disposables?: Array<{ dispose(): unknown }>
  ) => { dispose(): void }
}

export interface Disposable {
  dispose(): void
}

export interface KvStore {
  get<T>(key: string, defaultValue?: T): T | undefined
  update(key: string, value: unknown): Promise<void>
  keys(): readonly string[]
  setKeysForSync?(keys: readonly string[]): void
}

export interface SecretsStore {
  get(key: string): Promise<string | undefined>
  store(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

export interface VscodeShimFactory {
  /** Build a `vscode` module object specific to this extension. */
  (extensionId: string): unknown
}

interface LoadedExtension {
  extensionId: string
  exports: {
    activate?: (ctx: SidecarExtensionContext) => unknown | Promise<unknown>
    deactivate?: () => unknown | Promise<unknown>
  }
  packageJSON: Record<string, unknown>
  extensionPath: string
  context: SidecarExtensionContext | null
  active: boolean
  shim: unknown
}

const extensions = new Map<string, LoadedExtension>()
/** The host's binary-data constructors, given to every extension context. */
export const SHARED_BINARY_GLOBALS = {
  ArrayBuffer,
  SharedArrayBuffer,
  DataView,
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
} as const

/**
 * The host's web-platform globals Node gives every module and VS Code
 * extensions rely on, given to every extension context. The network ones
 * (`fetch`, `WebSocket`) are not here: they follow the extension's grants
 * (`createSandboxNetwork`).
 */
export const SHARED_WEB_GLOBALS = {
  queueMicrotask,
  structuredClone,
  AbortController,
  AbortSignal,
  Event,
  EventTarget,
  performance,
  atob,
  btoa,
  crypto,
  Blob,
  File,
  FormData,
  Headers,
  Request,
  Response,
  MessageChannel,
  MessagePort,
} as const

let shimFactory: VscodeShimFactory | null = null

export function setVscodeShimFactory(factory: VscodeShimFactory): void {
  shimFactory = factory
}

/**
 * Load an extension's main bundle into a fresh VM context. Throws when
 * the bundle can't be read or the `activate` export is missing.
 */
export async function loadExtension(req: ExtensionLoadRequest): Promise<void> {
  if (!shimFactory) {
    throw new Error("vscode shim factory not configured. Call setVscodeShimFactory() first.")
  }
  if (extensions.has(req.extensionId)) {
    throw new Error(`Extension "${req.extensionId}" already loaded`)
  }
  const mainPath = path.resolve(req.extensionPath, req.main)
  if (!fs.existsSync(mainPath)) {
    throw new Error(`Extension main bundle missing: ${mainPath}`)
  }
  const packageJsonPath = path.resolve(req.extensionPath, "package.json")
  let packageJSON: Record<string, unknown> = {}
  if (fs.existsSync(packageJsonPath)) {
    try {
      packageJSON = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as Record<string, unknown>
    } catch {
      // Tolerate malformed manifests — they shouldn't reach the sidecar.
    }
  }
  const shim = shimFactory(req.extensionId)
  registerVscodeShim(req.extensionId, shim)

  // Compile + run the bundle inside a fresh context.
  const source = fs.readFileSync(mainPath, "utf-8")
  const moduleExports: Record<string, unknown> = {}
  const moduleObj = { exports: moduleExports }
  const sandbox = {
    module: moduleObj,
    exports: moduleExports,
    require: createRequireForExtension(req.extensionId, mainPath),
    __dirname: path.dirname(mainPath),
    __filename: mainPath,
    process: createSandboxProcess(req.extensionId),
    Buffer,
    console: createSandboxConsole(req.extensionId),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Promise,
    // Binary data crosses the API constantly (`workspace.fs`, `TextEncoder`,
    // `Buffer`), and the host makes it with its own constructors. Sharing
    // them keeps `bytes instanceof Uint8Array` true inside the extension.
    ...SHARED_BINARY_GLOBALS,
    ...SHARED_WEB_GLOBALS,
    ...createSandboxNetwork(req.extensionId),
  } as Record<string, unknown>

  if (req.bundleFormat === "esm") {
    throw new Error(
      "ESM bundle support requires --experimental-vm-modules. cognia ships ESM support in Phase M3."
    )
  }
  vm.createContext(sandbox)
  try {
    // Node's `global`, as bundles written for Node expect: the context's own global.
    vm.runInContext("globalThis.global = globalThis", sandbox)
    const script = new vm.Script(source, { filename: mainPath })
    script.runInContext(sandbox)
  } catch (err) {
    unregisterVscodeShim(req.extensionId)
    throw err instanceof Error ? err : new Error(String(err))
  }

  const activate = (moduleObj.exports as { activate?: unknown })?.activate
  if (typeof activate !== "function") {
    unregisterVscodeShim(req.extensionId)
    throw new Error(`Extension "${req.extensionId}" did not export an activate() function`)
  }
  extensions.set(req.extensionId, {
    extensionId: req.extensionId,
    exports: moduleObj.exports as LoadedExtension["exports"],
    packageJSON,
    extensionPath: req.extensionPath,
    context: null,
    active: false,
    shim,
  })
}

/**
 * Activate a previously-loaded extension. Returns the value the
 * extension's `activate()` function returned (used by VS Code for
 * cross-extension API consumption via `extensions.getExtension(id).exports`).
 */
export async function activateExtension(
  extensionId: string,
  context: SidecarExtensionContext
): Promise<unknown> {
  const entry = extensions.get(extensionId)
  if (!entry) {
    throw new Error(`Extension "${extensionId}" not loaded`)
  }
  if (entry.active) {
    return entry.exports.activate ? undefined : undefined
  }
  if (!entry.exports.activate) {
    throw new Error(`Extension "${extensionId}" has no activate()`)
  }
  context.extension = {
    id: extensionId,
    extensionPath: entry.extensionPath,
    extensionUri: context.extensionUri,
    isActive: true,
    packageJSON: entry.packageJSON,
  }
  entry.context = context
  let result: unknown = undefined
  try {
    result = await entry.exports.activate(context)
  } catch (err) {
    entry.context = null
    throw err
  }
  entry.active = true
  context.extension.exports = result
  return result
}

/**
 * Run `deactivate()` (if exported) and dispose every tracked subscription.
 * Idempotent — safe to call on an extension that never activated.
 */
export async function deactivateExtension(extensionId: string): Promise<void> {
  const entry = extensions.get(extensionId)
  if (!entry || !entry.active) return
  if (entry.exports.deactivate) {
    try {
      await entry.exports.deactivate()
    } catch (err) {
      process.stderr.write(
        `[vscode-ext-host] deactivate threw for ${extensionId}: ${
          err instanceof Error ? err.message : String(err)
        }\n`
      )
    }
  }
  if (entry.context) {
    // Dispose in reverse order — VS Code does the same.
    for (let i = entry.context.subscriptions.length - 1; i >= 0; i -= 1) {
      try {
        entry.context.subscriptions[i]!.dispose()
      } catch (err) {
        process.stderr.write(
          `[vscode-ext-host] subscription dispose threw for ${extensionId}: ${
            err instanceof Error ? err.message : String(err)
          }\n`
        )
      }
    }
    entry.context.subscriptions.length = 0
  }
  entry.active = false
}

export function unloadExtension(extensionId: string): boolean {
  const entry = extensions.get(extensionId)
  if (!entry) return false
  if (entry.active) {
    // The renderer should have called deactivate first; do it defensively.
    void deactivateExtension(extensionId)
  }
  unregisterVscodeShim(extensionId)
  extensions.delete(extensionId)
  return true
}

export function getLoadedExtension(extensionId: string): LoadedExtension | undefined {
  return extensions.get(extensionId)
}

export function listLoadedExtensions(): LoadedExtension[] {
  return [...extensions.values()]
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function createRequireForExtension(extensionId: string, mainPath: string): NodeRequire {
  // node:module's createRequire returns a require() rooted at the main
  // bundle's directory — exactly what we want so the extension's
  // `require()` resolves siblings and node_modules under its own path.
  // We can't import createRequire at the top level when vm.Script is
  // running so we re-resolve here per extension.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createRequire } = require("node:module") as typeof import("node:module")
  const req = createRequire(mainPath) as NodeRequire & {
    cogniaExtensionId?: string
  }
  // Tag so the require-hook resolver can attribute calls back to us.
  req.cogniaExtensionId = extensionId
  return req
}

/**
 * `fetch` and `WebSocket` for one extension. Each works only while the
 * extension may load the module behind the same reach (`https` for
 * `network:fetch`, `ws` for `network:websocket`), checked on every call, and
 * goes through the user's proxy (`network.ts`). Without the grant `fetch`
 * rejects and `new WebSocket` throws, naming the permission, and the refusal
 * lands in the extension's log.
 */
export function createSandboxNetwork(extensionId: string): {
  fetch: typeof fetch
  WebSocket: typeof WebSocket
} {
  const refuse = (what: string, permission: string) => {
    const message = `${what} is not available to extension "${extensionId}": it needs the ${permission} permission`
    process.stderr.write(`[vscode-ext-host] WARN ${message}\n`)
    return new TypeError(message)
  }
  const gatedFetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    isModuleGranted(extensionId, "https")
      ? fetch(input, init)
      : Promise.reject(refuse("fetch", "network:fetch"))) as typeof fetch
  const HostWebSocket = WebSocket
  function GatedWebSocket(
    this: unknown,
    url: string | URL,
    protocols?: string | string[]
  ): WebSocket {
    if (!new.target) throw new TypeError("Constructor WebSocket requires 'new'")
    if (!isModuleGranted(extensionId, "ws")) throw refuse("WebSocket", "network:websocket")
    return new HostWebSocket(url, protocols)
  }
  // `instanceof WebSocket`, the static constants and `WebSocket.prototype`
  // behave as the host's.
  GatedWebSocket.prototype = HostWebSocket.prototype
  Object.setPrototypeOf(GatedWebSocket, HostWebSocket)
  return { fetch: gatedFetch, WebSocket: GatedWebSocket as unknown as typeof WebSocket }
}

function createSandboxProcess(extensionId: string): NodeJS.Process {
  // We expose a slimmed-down `process` object — same surface VS Code
  // gives extensions but with overridable env so we can isolate them.
  return new Proxy(process, {
    get(target, prop, receiver) {
      if (prop === "exit") {
        return (code?: number) => {
          process.stderr.write(
            `[vscode-ext-host] extension "${extensionId}" called process.exit(${code ?? 0}) — intercepted\n`
          )
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  }) as NodeJS.Process
}

function createSandboxConsole(extensionId: string): Console {
  const wrap =
    (level: "log" | "info" | "warn" | "error" | "debug") =>
    (...args: unknown[]) => {
      // Prefix every line so the renderer can attribute it.
      const text = args.map((a) => (typeof a === "string" ? a : safeJson(a))).join(" ")
      const fn = console[level] as (msg: string) => void
      fn(`[ext:${extensionId}] ${text}`)
    }
  return {
    ...console,
    log: wrap("log"),
    info: wrap("info"),
    warn: wrap("warn"),
    error: wrap("error"),
    debug: wrap("debug"),
  } as Console
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export function __resetExtensionRunnerForTesting(): void {
  extensions.clear()
  shimFactory = null
}
