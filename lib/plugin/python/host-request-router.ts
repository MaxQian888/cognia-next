/**
 * Routes `host_request` frames from a Python plugin onto the host's `ctx.*`
 * API surface (ADR-0145).
 *
 * A Python plugin has no direct access to anything: its process speaks NDJSON
 * over stdio and nothing else. `cognia.ctx.agent.run(...)` therefore writes a
 * `host_request` frame, which Rust forwards here, which resolves the dotted
 * method against the plugin's own `PluginContext` and answers with
 * `plugin_python_host_response`.
 *
 * **Permissions are not enforced here, deliberately.** The context handed to
 * this router is the one `createFullPluginContext` already wrapped in
 * `createGuardedAPI`, so every namespace carries the same manifest-permission
 * gate a TypeScript plugin hits. Re-checking here would mean a second copy of
 * the permission table to drift out of sync — the failure mode ADR-0087
 * recorded when the contract started lying about python capabilities.
 */

import type { PluginContext } from "@/types/plugin/plugin"

/** One plugin → host RPC frame, as it arrives from the Rust runtime. */
export interface PythonHostRequestFrame {
  pluginId: string
  /** Host lifecycle generation; echoed back so a respawn can't be answered. */
  generation: string
  /** Plugin-assigned id, unique within one host process. */
  requestId: number
  /** Dotted path into the context, e.g. `agent.run`, `agent.sessions.send`. */
  method: string
  params: unknown
}

/** What the router decided; the caller writes it back over the wire. */
export type PythonHostCallOutcome = { ok: true; result: unknown } | { ok: false; error: string }

export interface PythonHostRequestDeps {
  /** The plugin's guarded context, or null/undefined when it isn't loaded. */
  getContext: (pluginId: string) => PluginContext | null | undefined
}

/**
 * Segments that must never be traversed. `__proto__` / `prototype` /
 * `constructor` are the prototype-pollution triple; a leading underscore is
 * how the rest of the plugin surface marks something private, and the Python
 * side refuses to *emit* those — this refuses to *honour* them, so a
 * hand-written frame can't reach further than the SDK can.
 */
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"])

function isTraversable(value: unknown): value is Record<string, unknown> {
  return (typeof value === "object" && value !== null) || typeof value === "function"
}

/**
 * Split a `host_request` params object back into a call's arguments.
 *
 * Mirrors `_pack_params` in `host.py`: keyword calls arrive as the object
 * itself, positional calls as a lone `args` array. A mixed call (`f(a, b=1)`)
 * packs both, and unpacks here as the single object it became — the SDK's
 * typed layer keeps callers off that path.
 */
export function unpackHostCallArgs(params: unknown): unknown[] {
  if (params === undefined || params === null) return []
  if (Array.isArray(params)) return params
  if (typeof params !== "object") return [params]
  const record = params as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length === 0) return []
  if (keys.length === 1 && keys[0] === "args" && Array.isArray(record.args)) {
    return record.args
  }
  return [record]
}

/**
 * Resolve a dotted method path against a context and invoke it.
 *
 * Returns an outcome rather than throwing: every failure mode — unloaded
 * plugin, unknown namespace, permission denial from the guarded API — has to
 * reach the plugin as a value, because the alternative is a frame nobody
 * answers and a plugin that stalls until its own timeout.
 */
export async function routePythonHostRequest(
  frame: PythonHostRequestFrame,
  deps: PythonHostRequestDeps
): Promise<PythonHostCallOutcome> {
  const segments = frame.method.split(".").filter((part) => part.length > 0)
  if (segments.length < 2) {
    return {
      ok: false,
      error: `invalid host call '${frame.method}': expected '<namespace>.<method>'`,
    }
  }
  for (const segment of segments) {
    if (FORBIDDEN_SEGMENTS.has(segment) || segment.startsWith("_")) {
      return { ok: false, error: `host call '${frame.method}' traverses a private path` }
    }
  }

  const context = deps.getContext(frame.pluginId)
  if (!context) {
    return {
      ok: false,
      error: `plugin ${frame.pluginId} has no active context; host calls are unavailable`,
    }
  }

  let holder: unknown = context
  for (const segment of segments.slice(0, -1)) {
    if (!isTraversable(holder)) {
      return { ok: false, error: `host call '${frame.method}': '${segment}' is not available` }
    }
    holder = (holder as Record<string, unknown>)[segment]
    if (holder === undefined || holder === null) {
      return { ok: false, error: `host call '${frame.method}': '${segment}' is not available` }
    }
  }

  const methodName = segments[segments.length - 1]
  if (!isTraversable(holder)) {
    return { ok: false, error: `host call '${frame.method}' is not available` }
  }
  const fn = (holder as Record<string, unknown>)[methodName]
  if (typeof fn !== "function") {
    return { ok: false, error: `host call '${frame.method}' is not a function` }
  }

  try {
    const result = await (fn as (...args: unknown[]) => unknown).apply(
      holder,
      unpackHostCallArgs(frame.params)
    )
    return { ok: true, result: toWireValue(result) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Coerce a return value into something `JSON.stringify` survives.
 *
 * `undefined` becomes `null` (the wire has no undefined), and anything that
 * cannot be serialized — a class instance holding a socket, a cycle — is
 * reported as an error string rather than silently arriving as `{}` in the
 * plugin, which is the shape bugs hide in.
 */
function toWireValue(result: unknown): unknown {
  if (result === undefined) return null
  try {
    JSON.stringify(result)
    return result
  } catch {
    throw new Error(`host call returned a value that is not JSON-serializable (${typeof result})`)
  }
}
