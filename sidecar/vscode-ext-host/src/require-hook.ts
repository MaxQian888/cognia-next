/**
 * Module resolver intercept + runtime permission gate.
 *
 * Every `require("vscode")` (and `require("vscode-languageclient")`) inside
 * an extension lands on cognia's shim — Node has no built-in `vscode`
 * module, so the resolver would otherwise throw `MODULE_NOT_FOUND`.
 *
 * Additionally, every `require()` for sensitive Node built-ins (fs,
 * child_process, http, https, net, ws) routes through `requestPermission`
 * before the real module is returned. This is the runtime half of the
 * "dual gate" (static analysis at install time + runtime gate here).
 *
 * The hook is installed ONCE per sidecar — `installRequireHook` is
 * idempotent. Per-extension state is keyed by the extension id so multiple
 * extensions can run in the same sidecar without leaking permissions.
 */

import Module from "node:module"

const ORIGINAL_RESOLVE = (
  Module as unknown as {
    _resolveFilename: (request: string, parent: NodeModule | null) => string
  }
)._resolveFilename

const ORIGINAL_LOAD = (
  Module as unknown as {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown
  }
)._load

const SENSITIVE_MODULES = new Set([
  "fs",
  "fs/promises",
  "node:fs",
  "node:fs/promises",
  "child_process",
  "node:child_process",
  "worker_threads",
  "node:worker_threads",
  "http",
  "https",
  "node:http",
  "node:https",
  "net",
  "node:net",
  "tls",
  "node:tls",
  "ws",
])

let installed = false
const vscodeShimByExtension = new Map<string, unknown>()
let extensionResolver: ((parent: NodeModule | null) => string | null) | null = null
const grantCache = new Map<string, Set<string>>()

/**
 * Provide a way for the host to map a calling NodeModule back to a cognia
 * extension id. Without this we can't attribute permission requests
 * correctly (the call could come from a shared dependency).
 */
export function setExtensionResolver(resolver: (parent: NodeModule | null) => string | null): void {
  extensionResolver = resolver
}

/**
 * Register the `vscode` module instance an extension should see. Each
 * extension gets its own shim so per-call context (extension id, output
 * channel, secrets prefix) is captured by closure.
 */
export function registerVscodeShim(extensionId: string, shim: unknown): void {
  vscodeShimByExtension.set(extensionId, shim)
}

export function unregisterVscodeShim(extensionId: string): void {
  vscodeShimByExtension.delete(extensionId)
  grantCache.delete(extensionId)
}

/**
 * Replace the sensitive-module grants for one extension.
 *
 * CommonJS `require()` is synchronous, so authorization must be resolved by
 * the host before activation. The Rust host derives this list from the live,
 * non-expired permission ledger and sends it in `extension:load`; trying to
 * round-trip to JSON-RPC from inside `_load` would deadlock the Node event
 * loop that has to receive that response.
 */
export function setGrantedModules(extensionId: string, modules: readonly string[]): void {
  grantCache.set(extensionId, new Set(modules))
}

export function installRequireHook(): void {
  if (installed) return
  installed = true
  ;(
    Module as unknown as {
      _resolveFilename: (request: string, parent: NodeModule | null) => string
    }
  )._resolveFilename = function (request: string, parent: NodeModule | null) {
    if (request === "vscode") {
      // Return a synthetic path so the loader will pick it up via _load.
      return `cognia-vscode-shim:${resolveExtensionId(parent) ?? "unknown"}`
    }
    return ORIGINAL_RESOLVE.call(this, request, parent)
  }
  ;(
    Module as unknown as {
      _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown
    }
  )._load = function (request: string, parent: NodeModule | null, isMain: boolean) {
    if (request === "vscode") {
      const extId = resolveExtensionId(parent) ?? "unknown"
      const shim = vscodeShimByExtension.get(extId)
      if (!shim) {
        throw new Error(
          `cognia vscode shim not registered for extension "${extId}". This is a sidecar bug.`
        )
      }
      return shim
    }
    if (SENSITIVE_MODULES.has(request)) {
      const extId = resolveExtensionId(parent)
      if (extId) {
        if (!grantCache.get(extId)?.has(request)) {
          const err = new Error(`cognia denied "${request}" for extension "${extId}"`) as Error & {
            code?: string
          }
          err.code = "EPERM"
          throw err
        }
      }
    }
    return ORIGINAL_LOAD.call(this, request, parent, isMain)
  }
}

export function uninstallRequireHook(): void {
  if (!installed) return
  installed = false
  ;(
    Module as unknown as {
      _resolveFilename: (request: string, parent: NodeModule | null) => string
    }
  )._resolveFilename = ORIGINAL_RESOLVE
  ;(
    Module as unknown as {
      _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown
    }
  )._load = ORIGINAL_LOAD
  vscodeShimByExtension.clear()
  grantCache.clear()
  extensionResolver = null
}

function resolveExtensionId(parent: NodeModule | null): string | null {
  if (!extensionResolver) return null
  try {
    return extensionResolver(parent)
  } catch {
    return null
  }
}

/**
 * Test-only: clear all hook state. Production code never calls this.
 */
export function __resetRequireHookForTesting(): void {
  uninstallRequireHook()
}
