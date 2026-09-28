import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { SendOptions } from "../../shared/wire/inbound.ts"
import type { RuntimeQuery } from "./runtime-types.ts"
// Warm-subprocess pool for `startup()` (ADR-0090 plan Stage 4).
//
// `startup({ options, initializeTimeoutMs })` spawns a Claude Code subprocess
// and runs its initialize handshake WITHOUT a prompt, returning a `WarmQuery`.
// The first turn on a warm query skips spawn + handshake, which is most of the
// latency a user notices before the first token.
//
// A `WarmQuery` is single-use: `query(prompt)` may be called ONCE, or `close()`
// discards it. So this is a pool of one-shot claims, not a connection pool.
//
// The fingerprint is the whole design. A warm subprocess has already read
// settings, resolved credentials, and fixed its cwd, so handing one to a
// session that differs in ANY of those would silently run that session under
// another's configuration. Cross-tenant reuse would be a data leak; the rest
// would be a correctness bug that looks like a caching flake. So the key
// includes every input that changes what the subprocess became, and anything
// unrecognised makes the entry unpoolable rather than merged into a bucket.

/** How long an unclaimed warm subprocess is kept before being closed. */
export const DEFAULT_WARM_TTL_MS = 60_000

/** Ceiling on simultaneously-warm subprocesses. Each one is a real process. */
export const DEFAULT_WARM_CAPACITY = 2

/**
 * Fields of the resolved spec + options that MUST match for reuse.
 *
 * Anything affecting what the warm subprocess already did belongs here. The
 * list is explicit rather than "hash the whole options object" because the
 * options carry live objects (hooks, canUseTool, sessionStore) that have no
 * stable serialisation — hashing them would make every fingerprint unique and
 * silently disable pooling.
 */
const REBINDABLE_CALLBACKS = new Set(["canUseTool", "stderr"])

function immutableValue(
  value: unknown,
  path: (string | number)[] = [],
  seen = new Set<object>()
): unknown {
  if (value === undefined) return undefined
  if (typeof value === "function") {
    if (path.length === 1 && REBINDABLE_CALLBACKS.has(String(path[0]))) return "[rebound callback]"
    throw new Error("session-bound callback")
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "object" || seen.has(value))
    throw new Error("non-serializable startup resource")
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
    throw new Error("session-bound startup resource")
  seen.add(value)
  const result = Array.isArray(value)
    ? value.map((entry, index) => immutableValue(entry, [...path, index], seen))
    : Object.fromEntries(
        Object.keys(value)
          .sort()
          .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
          .map((key) => [
            key,
            immutableValue((value as Record<string, unknown>)[key], [...path, key], seen),
          ])
      )
  seen.delete(value)
  return result
}

export function warmFingerprint(sendOptions: SendOptions | undefined, options: Options = {}) {
  // Per-turn trace/identity fields do not configure the subprocess. All other
  // send policy plus every effective SDK startup option must match exactly.
  const { turnId: _turnId, traceparent: _traceparent, execution, ...policy } = sendOptions ?? {}
  const { identity: _identity, ...executionPolicy } = execution ?? {}
  return JSON.stringify([
    immutableValue({ ...policy, execution: executionPolicy }),
    immutableValue(options),
  ])
}

/**
 * A send that cannot safely reuse a warm subprocess.
 *
 * Returns a reason string, or null when pooling is allowed. Prewarming is an
 * optimisation, so every ambiguous case declines it — the cost of skipping the
 * pool is a slower first token, and the cost of a wrong reuse is a session
 * running under someone else's configuration.
 */
export function unpoolableReason(sendOptions: SendOptions | undefined, options: Options = {}) {
  const nested = sendOptions?.claudeAgentSdk
  if (!sendOptions?.execution) {
    // ADR-0090 constraint 6: the legacy queue keeps today's behaviour, and
    // today it spawns per send.
    return "no frozen execution spec"
  }
  if (
    nested?.sessionId ||
    nested?.continue ||
    sendOptions?.resume ||
    sendOptions?.resumeSessionId ||
    options.resume ||
    options.continue ||
    options.sessionId
  ) {
    // A resumed session's subprocess is spawned with `--resume`, so a warm one
    // started without it is a different process entirely.
    return "resuming an existing session"
  }
  if (nested?.enableFileCheckpointing) {
    // Checkpointing tracks files from process start; a subprocess warmed
    // before the session's cwd was known has nothing to checkpoint against.
    return "file checkpointing is enabled"
  }
  if (
    nested?.skills !== undefined ||
    (Array.isArray(nested?.plugins) && nested.plugins.length > 0)
  ) {
    // Native local content is resolved when the subprocess initializes. A
    // pooled process would retain it after Workspace Trust is revoked or the
    // next send selects a different extension set.
    return "native local skills/plugins are enabled"
  }
  if (nested?.extraArgs && Object.keys(nested.extraArgs).length > 0) {
    // Raw flags are intentionally rare and may change subprocess startup
    // semantics. Do not retain those semantics beyond the current send.
    return "raw Claude CLI flags are enabled"
  }
  if (sendOptions?.forkSession || sendOptions?.forkFromSessionId || options.forkSession)
    return "forking a session"
  if (options.sessionStore) return "session-bound persistence store"
  if (options.hooks && Object.values(options.hooks).some((entries) => entries?.length))
    return "session-bound lifecycle hooks"
  if (
    Object.values(options.mcpServers ?? {}).some(
      (server) => server?.type === "sdk" || (server && "instance" in server && server.instance)
    )
  )
    return "session-bound in-process MCP servers"
  try {
    warmFingerprint(sendOptions, options)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return null
}

/**
 * Create a pool.
 *
 * `startup` is injected so the pool is testable without spawning anything.
 *
 */
export interface WarmHandle<T = RuntimeQuery> {
  query(prompt: string | AsyncIterable<SDKUserMessage>): T
  close(): void
}
interface WarmEntry<T> {
  warm: WarmHandle<T>
  bindings: { current: Options | undefined }
  expiresAt: number
  timer: ReturnType<typeof setTimeout> | undefined
}
export interface WarmPoolDeps<T = RuntimeQuery> {
  startup(params: { options: Options; initializeTimeoutMs?: number }): Promise<WarmHandle<T>>
  now?: () => number
  ttlMs?: number
  capacity?: number
  log?: (level: "warn", message: string) => void
}
export function createWarmPool<T = RuntimeQuery>({
  startup,
  now = () => Date.now(),
  ttlMs = DEFAULT_WARM_TTL_MS,
  capacity = DEFAULT_WARM_CAPACITY,
  log = () => {},
}: WarmPoolDeps<T>) {
  const buckets = new Map<string, WarmEntry<T>[]>()
  let size = 0
  let generation = 0

  function discard(entry: WarmEntry<T>) {
    clearTimeout(entry.timer)
    entry.bindings.current = undefined
    try {
      entry.warm.close()
    } catch (error) {
      log(
        "warn",
        `prewarm: close failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  function remove(key: string, entry: WarmEntry<T>) {
    const entries = buckets.get(key)
    const index = entries?.indexOf(entry) ?? -1
    if (index < 0) return false
    entries!.splice(index, 1)
    if (!entries!.length) buckets.delete(key)
    size--
    return true
  }
  function dropExpired() {
    const cutoff = now()
    for (const [key, entries] of buckets)
      for (const entry of [...entries])
        if (entry.expiresAt <= cutoff && remove(key, entry)) discard(entry)
  }

  return {
    get size() {
      return size
    },
    async prewarm(sendOptions: SendOptions, options: Options = {}, initializeTimeoutMs?: number) {
      const reason = unpoolableReason(sendOptions, options)
      if (reason) return reason
      dropExpired()
      if (size >= capacity) return "pool is at capacity"
      const key = warmFingerprint(sendOptions, options)
      const startingGeneration = generation
      const bindings: WarmEntry<T>["bindings"] = { current: undefined }
      // Clone all data so the caller cannot mutate a warm process's options.
      const bound = immutableValue(options) as Options
      if (typeof options.canUseTool === "function")
        bound.canUseTool = (...args) =>
          bindings.current?.canUseTool?.(...args) ??
          Promise.resolve({ behavior: "deny", message: "Unclaimed prewarm query" })
      if (typeof options.stderr === "function")
        bound.stderr = (...args) => bindings.current?.stderr?.(...args)
      size++
      try {
        const warm = await startup({ options: bound, initializeTimeoutMs })
        const entry: WarmEntry<T> = { warm, bindings, expiresAt: now() + ttlMs, timer: undefined }
        if (startingGeneration !== generation) {
          discard(entry)
          return "pool closed during startup"
        }
        const entries = buckets.get(key) ?? []
        entries.push(entry)
        buckets.set(key, entries)
        entry.timer = setTimeout(() => {
          if (remove(key, entry)) discard(entry)
        }, ttlMs)
        entry.timer.unref?.()
        return null
      } catch (error) {
        if (startingGeneration === generation) size--
        log(
          "warn",
          `prewarm: startup failed: ${error instanceof Error ? error.message : String(error)}`
        )
        return "startup failed"
      }
    },
    claim(sendOptions: SendOptions, options: Options = {}) {
      if (unpoolableReason(sendOptions, options)) return null
      dropExpired()
      const key = warmFingerprint(sendOptions, options)
      const entry = buckets.get(key)?.[0]
      if (!entry || !remove(key, entry)) return null
      clearTimeout(entry.timer)
      entry.bindings.current = options
      return entry.warm
    },
    closeAll() {
      generation++
      for (const entries of buckets.values()) for (const entry of entries) discard(entry)
      buckets.clear()
      size = 0
    },
  }
}

/**
 * Whether a turn's result says it actually consumed a warm subprocess.
 *
 * `warm_spare_claimed` is the SDK's own signal, and it is the only honest way
 * to verify the pool: a claim that silently fell back to a cold spawn looks
 * identical from this side.
 */
export function claimedWarmSpare(result: { warm_spare_claimed?: unknown } | null | undefined) {
  return result?.warm_spare_claimed === true
}

// ---- process-wide pool ---------------------------------------------------------

let sharedPool: ReturnType<typeof createWarmPool<RuntimeQuery>> | null = null

/**
 * The sidecar's single pool, created on first use.
 *
 * Process-wide rather than per-session because the whole point is to have a
 * subprocess ready BEFORE the next session exists. `startup` is imported
 * lazily so this module stays loadable in contexts without the SDK installed
 * (the same reason `src/platform/telemetry/index.ts` defers its imports).
 *
 */
export function warmPool(deps: Pick<WarmPoolDeps, "log"> = {}) {
  if (!sharedPool) {
    sharedPool = createWarmPool({
      startup: async (params) => {
        const { startup } = await import("@anthropic-ai/claude-agent-sdk")
        return startup(params)
      },
      log: deps.log,
    })
  }
  return sharedPool
}

/** Drop the shared pool, closing everything in it. Host shutdown + tests. */
export function resetWarmPool() {
  sharedPool?.closeAll()
  sharedPool = null
}
