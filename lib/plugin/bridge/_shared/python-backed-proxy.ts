/**
 * Python-backed contribution proxy — the shared seam behind every
 * `backend: "python"` module-bridge contribution.
 *
 * Module bridges (`ocr-providers-bridge`, `ai-providers-bridge`,
 * `workspace-backend-bridge`, `connectors-bridge`, …) all resolve a
 * contribution into a **live object with methods** that the host calls later:
 * `provider.extract(image)`, `backend.clone(...)`, `adapter.send(...)`. A pure
 * Python plugin cannot hand back a JS object, so this factory synthesizes one
 * whose every method round-trips through the `plugin_python_call` RPC into the
 * plugin's Python subprocess.
 *
 * ## Wire contract
 *
 * Host → plugin is a single dispatcher symbol the Python SDK registers, so one
 * plugin can back many contributions without inventing a symbol per method:
 *
 * ```
 * plugin_python_call(pluginId, "__cognia_dispatch_contribution__",
 *                    [contributionId, method, args, streamId | null])
 * ```
 *
 * Plugin → host reuses the existing `plugin:python` event channel
 * (`crates/cognia-plugin-runtime/src/python/events.rs`), fanned out by
 * `lib/plugin/python/event-bus.ts`:
 *
 * - `kind: "chunk"`     — `data: { streamId, value }`, one streamed item
 * - `kind: "chunk_end"` — `data: { streamId }`, stream complete
 * - `kind: "emit"`      — `data: { contributionId, channel, payload }`, an
 *   unsolicited push (connector inbound messages, watcher events)
 *
 * Streams are correlated by a **seam-generated `streamId`**, not by the
 * protocol's internal `call_id`: that id is assigned inside the Rust NDJSON
 * layer and is never returned to the renderer, so it cannot be used from here.
 */

import { isHeadlessHost } from "@/lib/platform/detect"
import { subscribePythonPluginEvents } from "@/lib/plugin/python/event-bus"
import type { PythonPluginEvent } from "@/lib/plugin/python/log-buffer"
import { capturePythonRuntimeGeneration } from "@/lib/plugin/python/runtime-generation"

/** Python symbol the SDK registers to route contribution method calls. */
export const PYTHON_CONTRIBUTION_DISPATCH = "__cognia_dispatch_contribution__"

/** How the seam reaches the Python subprocess. Tests inject a fake. */
export type PythonCallTransport = (
  pluginId: string,
  functionName: string,
  args: readonly unknown[]
) => Promise<unknown>

/** How the seam observes plugin→host frames. Tests inject a fake. */
export type PythonEventSubscribe = (listener: (event: PythonPluginEvent) => void) => () => void

export interface PythonBackedProxyOptions {
  /** Owning plugin id. */
  pluginId: string
  /** Contribution id (`manifest.<field>[].id`) — disambiguates several
   *  contributions backed by the same plugin. */
  contributionId: string
  /** Method names the produced object must expose. */
  methods: readonly string[]
  /** Subset of `methods` that stream; those return an `AsyncGenerator` which
   *  yields each chunk and returns the call's final value. */
  streamingMethods?: readonly string[]
  /** Human-readable capability label used in error messages. */
  label?: string
  call?: PythonCallTransport
  subscribe?: PythonEventSubscribe
  /** Stream-id factory — deterministic in tests. */
  newStreamId?: () => string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Default transport, mirroring `PluginManager.invokePluginRuntime`. Imported
 *  lazily so this module stays safe in the web/mobile bundle. */
const defaultCall = async (
  pluginId: string,
  generation: string,
  functionName: string,
  args: readonly unknown[]
): Promise<unknown> => {
  if (!isHeadlessHost()) {
    const { invoke } = await import("@tauri-apps/api/core")
    return invoke("plugin_python_call", { pluginId, generation, functionName, args })
  }
  const { transport } = await import("@/lib/tauri/transport-instance")
  return transport.call("plugin_python_call", { pluginId, generation, functionName, args })
}

let streamCounter = 0
const defaultNewStreamId = (): string => `s${++streamCounter}-${Date.now().toString(36)}`

function describe(options: PythonBackedProxyOptions, method: string): string {
  const what = options.label ? `${options.label} ` : ""
  return `${what}"${options.pluginId}:${options.contributionId}".${method}`
}

function wrapFailure(options: PythonBackedProxyOptions, method: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  const wrapped = new Error(`python-backed ${describe(options, method)} failed: ${message}`)
  if (error instanceof Error && error.stack) wrapped.stack = error.stack
  return wrapped
}

/**
 * Build a JS object whose methods execute inside the plugin's Python
 * subprocess. Non-streaming methods resolve with the handler's return value;
 * streaming methods return an `AsyncGenerator` yielding chunks and returning
 * the final value.
 */
export function createPythonBackedProxy<T extends object>(options: PythonBackedProxyOptions): T {
  const generation = options.call ? null : capturePythonRuntimeGeneration(options.pluginId)
  const call =
    options.call ??
    ((pluginId, functionName, args) => defaultCall(pluginId, generation!, functionName, args))
  const subscribe = options.subscribe ?? subscribePythonPluginEvents
  const newStreamId = options.newStreamId ?? defaultNewStreamId
  const streaming = new Set(options.streamingMethods ?? [])
  const proxy: Record<string, unknown> = {}

  for (const method of options.methods) {
    if (!streaming.has(method)) {
      proxy[method] = async (...args: unknown[]): Promise<unknown> => {
        try {
          return await call(options.pluginId, PYTHON_CONTRIBUTION_DISPATCH, [
            options.contributionId,
            method,
            args,
            null,
          ])
        } catch (error) {
          throw wrapFailure(options, method, error)
        }
      }
      continue
    }

    proxy[method] = (...args: unknown[]): AsyncGenerator<unknown, unknown, void> =>
      streamMethod(options, call, subscribe, generation, newStreamId(), method, args)
  }

  return proxy as T
}

async function* streamMethod(
  options: PythonBackedProxyOptions,
  call: PythonCallTransport,
  subscribe: PythonEventSubscribe,
  generation: string | null,
  streamId: string,
  method: string,
  args: readonly unknown[]
): AsyncGenerator<unknown, unknown, void> {
  const chunks: unknown[] = []
  let finished = false
  let notify: (() => void) | null = null
  const wake = (): void => {
    const pending = notify
    notify = null
    pending?.()
  }

  const unsubscribe = subscribe((event) => {
    if (event.pluginId !== options.pluginId) return
    if (generation && event.generation !== generation) return
    const data = isRecord(event.data) ? event.data : null
    if (!data || data.streamId !== streamId) return
    if (event.kind === "chunk") {
      chunks.push(data.value)
      wake()
    } else if (event.kind === "chunk_end") {
      finished = true
      wake()
    }
  })

  let result: unknown
  let failure: unknown
  const settled = call(options.pluginId, PYTHON_CONTRIBUTION_DISPATCH, [
    options.contributionId,
    method,
    args,
    streamId,
  ]).then(
    (value) => {
      result = value
      finished = true
      wake()
    },
    (error) => {
      failure = error
      finished = true
      wake()
    }
  )

  try {
    for (;;) {
      while (chunks.length > 0) {
        yield chunks.shift()
      }
      if (finished) break
      await new Promise<void>((resolve) => {
        notify = resolve
        // An event may have landed between draining `chunks` and installing
        // `notify` — re-check so the generator can never park on a stream that
        // has already progressed.
        if (finished || chunks.length > 0) {
          notify = null
          resolve()
        }
      })
    }
    await settled
    if (failure !== undefined) throw wrapFailure(options, method, failure)
    return result
  } finally {
    unsubscribe()
  }
}

/**
 * Method every python-backed contribution exposes to hand back its plain-data
 * descriptor (a JS factory returns those fields inline; Python has to be asked).
 */
export const PYTHON_CONTRIBUTION_DESCRIBE = "describe"

/**
 * Does this contribution entry execute in Python?
 *
 * Mirrors `effectiveContributionBackend` in `lib/plugin/core/validation.ts`
 * — keep the two rule-for-rule in lockstep:
 *   1. an explicit per-entry `backend` wins;
 *   2. a declared JS module path (`entry`) means JS — writing one is itself the
 *      declaration of intent, so it is never silently ignored;
 *   3. otherwise the plugin type decides (`python` → python, else JS).
 */
export function isPythonBackedContribution(
  def: unknown,
  pluginType: string | undefined,
  entryField = "entry"
): boolean {
  if (isRecord(def) && typeof def.backend === "string") return def.backend === "python"
  if (isRecord(def) && typeof def[entryField] === "string" && def[entryField] !== "") return false
  return pluginType === "python"
}

/**
 * Build a python-backed contribution the way a JS factory would: ask Python for
 * its descriptor (`describe`), then graft the proxied methods on top. The
 * result is shape-compatible with whatever the JS branch produces, so bridges
 * register it through their existing path unchanged.
 */
export async function createDescribedPythonContribution<T extends object>(
  options: PythonBackedProxyOptions
): Promise<T> {
  const proxy = createPythonBackedProxy<Record<string, (...args: unknown[]) => unknown>>({
    ...options,
    methods: [PYTHON_CONTRIBUTION_DESCRIBE, ...options.methods],
  })
  const described = await proxy[PYTHON_CONTRIBUTION_DESCRIBE]()
  const merged: Record<string, unknown> = isRecord(described) ? { ...described } : {}
  for (const method of options.methods) {
    merged[method] = proxy[method]
  }
  return merged as T
}

export interface PythonContributionPush {
  /** Logical channel the plugin emitted on (e.g. `"inbound"`). */
  channel: string
  payload: unknown
}

/**
 * Observe unsolicited plugin→host pushes for one contribution — the inbound
 * half of a bidirectional adapter (connector messages, watcher events).
 *
 * @returns an unsubscribe function.
 */
export function subscribePythonContributionPush(options: {
  pluginId: string
  contributionId: string
  onPush: (push: PythonContributionPush) => void
  subscribe?: PythonEventSubscribe
}): () => void {
  const subscribe = options.subscribe ?? subscribePythonPluginEvents
  return subscribe((event) => {
    if (event.pluginId !== options.pluginId || event.kind !== "emit") return
    const data = isRecord(event.data) ? event.data : null
    if (!data || data.contributionId !== options.contributionId) return
    if (typeof data.channel !== "string") return
    options.onPush({ channel: data.channel, payload: data.payload })
  })
}
