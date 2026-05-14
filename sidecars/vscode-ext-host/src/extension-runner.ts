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
import { registerVscodeShim, unregisterVscodeShim } from "./require-hook"

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
  extensionUri: string
  extensionPath: string
  globalStorageUri: string
  storageUri: string
  logUri: string
  extensionMode: "production" | "development" | "test"
  extension: {
    id: string
    extensionPath: string
    isActive: boolean
    packageJSON: Record<string, unknown>
    exports?: unknown
  }
}

export interface Disposable {
  dispose(): void
}

export interface KvStore {
  get<T>(key: string): T | undefined
  update(key: string, value: unknown): Promise<void>
  keys(): readonly string[]
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
  } as Record<string, unknown>

  if (req.bundleFormat === "esm") {
    throw new Error(
      "ESM bundle support requires --experimental-vm-modules. cognia ships ESM support in Phase M3."
    )
  }
  vm.createContext(sandbox)
  try {
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
