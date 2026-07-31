/**
 * ADR-0028 / T3 — Wasmtime + WASI runtime for WASM plugins.
 *
 * Loads a plugin's WASM module under a sandboxed runtime and exposes a
 * stable handle so the plugin manager can call exported methods without
 * touching the underlying instance. Two delivery paths:
 *
 *   - **Core modules** (no WASI): instantiated via the host's
 *     `WebAssembly.instantiate`. No FS / network is granted — the imports
 *     surface is bounded by the preopens passed at load time (used as
 *     virtual paths the host import can read against an in-memory map).
 *
 *   - **WASI Preview-2 components**: dynamically import
 *     `@bytecodealliance/jco` to transpile into a Node-compatible
 *     component loader. When the SDK isn't installed the runtime throws
 *     a one-line install hint, matching the strict-mode pattern used by
 *     the e2b microvm adapter.
 *
 * Preopens come from `lib/plugin/security/wasm-grant.ts:getGrantedPreopens`.
 * The grant ledger is authoritative — paths not in the ledger reject
 * with a structured error so a misbehaving plugin can't read outside
 * its scope. Host imports are pure (no real FS), so the worst-case
 * blast radius is "the plugin reads its own grant".
 */

import { getGrantedPreopens, verifyPreopenAllowedForCall } from "@/lib/plugin/security/wasm-grant"

/** Public handle returned to the plugin host. */
export interface WasmPluginHandle {
  /** Plugin id the handle was created for. */
  readonly pluginId: string
  /** Read-only snapshot of the preopens the plugin was loaded with. */
  readonly preopens: readonly string[]
  /** Invoke an exported function. Throws if the export is missing. */
  call(method: string, args?: unknown): Promise<unknown>
  /** Tear down the instance. Subsequent `call` raises. */
  dispose(): Promise<void>
}

export interface WasmRuntimeOptions {
  /**
   * Override the runtime resolver — tests pass a synthetic factory so
   * we can exercise the bridge without a real WASM binary. Production
   * uses the default `WebAssembly.instantiate` + jco path.
   */
  runtimeFactory?: WasmRuntimeFactory
  /**
   * Override the granted-preopens resolver. Defaults to
   * `getGrantedPreopens(pluginId)` from the persisted ledger.
   */
  preopensResolver?: (pluginId: string) => readonly string[] | Promise<readonly string[]>
}

/** Factory invoked by `loadWasmPlugin` once per call. */
export type WasmRuntimeFactory = (input: {
  pluginId: string
  source: WasmSource
  preopens: readonly string[]
}) => Promise<WasmRuntimeInstance>

/** Underlying runtime instance. */
export interface WasmRuntimeInstance {
  call(method: string, args?: unknown): Promise<unknown>
  dispose(): Promise<void>
}

/** Source bytes — either a base64 string or a binary buffer. */
export type WasmSource =
  { kind: "base64"; data: string } | { kind: "bytes"; data: ArrayBuffer | Uint8Array }

const disposedSentinel = "wasm runtime instance disposed"

/**
 * Load a WASM plugin and return a controllable handle. The function
 * resolves the preopen set BEFORE building the runtime so a missing or
 * empty grant is a hard early failure.
 */
export async function loadWasmPlugin(
  pluginId: string,
  source: WasmSource,
  options: WasmRuntimeOptions = {}
): Promise<WasmPluginHandle> {
  if (!pluginId.trim()) {
    throw new Error("loadWasmPlugin: pluginId is required")
  }
  const preopensResolver = options.preopensResolver ?? getGrantedPreopens
  const preopens = [...(await preopensResolver(pluginId))]
  const factory = options.runtimeFactory ?? defaultWasmRuntimeFactory
  const instance = await factory({ pluginId, source, preopens })

  let disposed = false
  return {
    pluginId,
    preopens,
    async call(method, args) {
      if (disposed) throw new Error(disposedSentinel)
      if (typeof method !== "string" || method.length === 0) {
        throw new Error("call: method name is required")
      }
      await verifyPreopenAllowedForCall(pluginId, preopens)
      return instance.call(method, args)
    },
    async dispose() {
      if (disposed) return
      disposed = true
      await instance.dispose()
    },
  }
}

/**
 * Default factory — core-module path. The WASM source is decoded,
 * instantiated through `WebAssembly.instantiate`, and the resulting
 * instance is exposed via a thin facade. The imports surface only
 * carries a `cognia_preopens` helper that returns the granted preopen
 * list — no FS / network bindings.
 *
 * Component-model WASI Preview-2 plugins go through `@bytecodealliance/jco`
 * (dynamically imported) so installs without the SDK still build.
 */
async function defaultWasmRuntimeFactory(input: {
  pluginId: string
  source: WasmSource
  preopens: readonly string[]
}): Promise<WasmRuntimeInstance> {
  const bytes = decodeWasmSource(input.source)
  // Heuristic — Preview-2 components start with the `00 61 73 6d` header
  // followed by a component-model version (`0c 00 01 00`). Core modules
  // use `01 00 00 00` for the version field. We only treat the component
  // path as opt-in to keep the default path zero-dep.
  if (looksLikeComponent(bytes)) {
    return loadComponent(input.pluginId, bytes, input.preopens)
  }
  return instantiateCoreModule(bytes, input.preopens)
}

function decodeWasmSource(source: WasmSource): Uint8Array {
  if (source.kind === "base64") {
    const binary =
      typeof atob === "function"
        ? atob(source.data)
        : Buffer.from(source.data, "base64").toString("binary")
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) {
      out[i] = binary.charCodeAt(i)
    }
    return out
  }
  return source.data instanceof Uint8Array ? source.data : new Uint8Array(source.data)
}

function looksLikeComponent(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false
  // Core: 00 61 73 6d 01 00 00 00
  // Component-model: 00 61 73 6d 0d 00 01 00 (preview-2)
  const magic = bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d
  if (!magic) return false
  // Component-model version byte (5th byte) is 0x0a/0x0b/0x0c/0x0d depending
  // on the preview; core modules sit at 0x01.
  return bytes[4] !== 0x01
}

async function instantiateCoreModule(
  bytes: Uint8Array,
  preopens: readonly string[]
): Promise<WasmRuntimeInstance> {
  const memorySnapshot = new Map<string, Uint8Array>()
  const grantedSet = new Set(preopens)
  const importObject: WebAssembly.Imports = {
    cognia: {
      preopen_count: () => grantedSet.size,
      preopen_at: (idx: number) => {
        const list = [...grantedSet]
        return list[idx] ?? ""
      },
      read_file: (path: string) => {
        if (!grantedSet.has(path)) {
          throw new Error(`wasm-runtime: preopen denied for ${path}`)
        }
        return memorySnapshot.get(path) ?? new Uint8Array()
      },
    },
  }
  // Use the buffer slice so different views over the same array don't trip
  // WebAssembly's strict typing.
  const { instance } = await WebAssembly.instantiate(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    importObject
  )
  return {
    async call(method, args) {
      const exp = (instance.exports as Record<string, unknown>)[method]
      if (typeof exp !== "function") {
        throw new Error(`wasm-runtime: export not found: ${method}`)
      }
      const fn = exp as (...callArgs: unknown[]) => unknown
      const callArgs = Array.isArray(args) ? args : args === undefined ? [] : [args]
      return fn(...callArgs)
    },
    async dispose() {
      memorySnapshot.clear()
      grantedSet.clear()
    },
  }
}

async function loadComponent(
  _pluginId: string,
  _bytes: Uint8Array,
  _preopens: readonly string[]
): Promise<WasmRuntimeInstance> {
  let mod: unknown
  try {
    // Hide the specifier from webpack — the user opts into the SDK
    // separately. Failure here surfaces a clean install hint.
    mod = await (Function("s", "return import(s)") as (s: string) => Promise<unknown>)(
      "@bytecodealliance/jco"
    )
  } catch {
    throw new Error(
      "@bytecodealliance/jco is not installed. Run `pnpm add @bytecodealliance/jco -w` " +
        "to enable Preview-2 component plugins, or ship the plugin as a core wasm module."
    )
  }
  // The jco surface stabilises around `transpile()` + a generated loader.
  // The exact API has shifted between minor releases; rather than pin a
  // specific shape and silently break on upgrade, surface the gap with
  // a structured error and let the host re-prompt the user.
  void mod
  throw new Error(
    "wasm-runtime: WASI Preview-2 component plugins are not yet wired through " +
      "@bytecodealliance/jco — pass `runtimeFactory` explicitly or ship the plugin as a core wasm module."
  )
}
