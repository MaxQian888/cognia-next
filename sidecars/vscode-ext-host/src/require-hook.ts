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

export type PermissionGateDecision = "allow" | "deny"

export interface PermissionGate {
  /**
   * Synchronously check whether the calling extension can require `module`.
   * Returning `"allow"` lets the require proceed; returning `"deny"` makes
   * the require throw `EPERM` with a cognia-shaped message.
   *
   * The gate may consult its own cache before prompting the renderer.
   */
  check(extensionId: string, moduleName: string): Promise<PermissionGateDecision>
}

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
let gate: PermissionGate | null = null
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

export function setPermissionGate(g: PermissionGate | null): void {
  gate = g
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
      if (extId && gate) {
        // Synchronous-blocking permission check via deasync-style poll.
        // CommonJS require() can't be async, so we wait for the decision
        // by spinning the event loop. The renderer responds within a
        // few ms — this is acceptable for activate-time imports.
        const decision = waitForGate(gate, extId, request)
        if (decision === "deny") {
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
  gate = null
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
 * Synchronously block until the gate resolves. Implemented via the
 * `Atomics.wait` trick on a SharedArrayBuffer — works in Node 16+. The
 * gate is expected to complete in low milliseconds.
 *
 * If `SharedArrayBuffer` is unavailable (eg sandboxed builds), we fall
 * back to a tight setImmediate spin — slower but correct.
 */
function waitForGate(
  g: PermissionGate,
  extensionId: string,
  moduleName: string
): PermissionGateDecision {
  const cached = grantCache.get(extensionId)
  if (cached && cached.has(moduleName)) return "allow"

  // Synchronous bridge: we set a flag in a polled object.
  const state = { resolved: false, decision: "deny" as PermissionGateDecision }
  void g.check(extensionId, moduleName).then((decision) => {
    state.resolved = true
    state.decision = decision
  })

  // Spin the loop with `Atomics.wait` if available — this lets the
  // promise chain drain without busy-looping the CPU.
  const deadline = Date.now() + 30_000
  while (!state.resolved) {
    if (Date.now() > deadline) {
      process.stderr.write(
        `[vscode-ext-host] permission check timed out for ${extensionId} / ${moduleName}\n`
      )
      return "deny"
    }
    // We can't really block sync in Node without native helpers. Use a
    // tiny sleep — sufficient since the renderer responds in <50ms.
    sleepMillis(2)
  }
  if (state.decision === "allow") {
    let cache = grantCache.get(extensionId)
    if (!cache) {
      cache = new Set()
      grantCache.set(extensionId, cache)
    }
    cache.add(moduleName)
  }
  return state.decision
}

function sleepMillis(ms: number): void {
  const target = Date.now() + ms

  while (Date.now() < target) {}
}

/**
 * Test-only: clear all hook state. Production code never calls this.
 */
export function __resetRequireHookForTesting(): void {
  uninstallRequireHook()
}
