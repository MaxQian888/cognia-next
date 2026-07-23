/**
 * Langfuse Client — real-when-available, no-op-when-not.
 *
 * The langfuse log transport dynamically imports this module and calls
 * `getLangfuse(...)`. If the user has installed the `langfuse` npm package
 * AND configured `publicKey` + `secretKey`, we instantiate a real client.
 * Otherwise we hand back a no-op so the transport stays "configured but
 * silent" — the panel reports the langfuse transport as `Degraded` until
 * real credentials land.
 *
 * Cognia's full observability integration (chat-trace correlation, model
 * cost mapping, user feedback round-trip) is intentionally not ported here.
 * This module only covers the logger-side surface.
 */

interface MinimalGenOrSpan {
  update: (data: Record<string, unknown>) => void
  end: () => void
}

interface MinimalTrace {
  update: (data: Record<string, unknown>) => void
  end: () => void
  generation: (data: Record<string, unknown>) => MinimalGenOrSpan
  span: (data: Record<string, unknown>) => MinimalGenOrSpan
  getTraceUrl?: () => string
}

interface MinimalLangfuseClient {
  trace: (data: Record<string, unknown>) => MinimalTrace
  flush: () => Promise<void>
  flushAsync: () => Promise<void>
}

const noopGenSpan: MinimalGenOrSpan = {
  update: () => {},
  end: () => {},
}

const noopTrace: MinimalTrace = {
  update: () => {},
  end: () => {},
  generation: () => noopGenSpan,
  span: () => noopGenSpan,
}

const NOOP_CLIENT: MinimalLangfuseClient = {
  trace: () => noopTrace,
  flush: async () => {},
  flushAsync: async () => {},
}

// Open shape — keeps callers free to pass extra fields (`enabled`,
// `flushInterval`, etc.) without TypeScript complaints.
export interface LangfuseConfig {
  publicKey?: string
  secretKey?: string
  host?: string
  [key: string]: unknown
}

type LangfuseCtor = new (options: Record<string, unknown>) => MinimalLangfuseClient

let cachedCtor: LangfuseCtor | null = null
let resolveAttempted = false

async function resolveLangfuseCtor(): Promise<LangfuseCtor | null> {
  if (cachedCtor) return cachedCtor
  if (resolveAttempted) return null
  resolveAttempted = true
  try {
    // Optional dependency — the real Langfuse SDK ships under the `langfuse`
    // package name. The dynamic import keeps the bundler from resolving it
    // when not installed, so the production bundle stays slim.
    const mod = (await import(/* webpackIgnore: true */ "langfuse")) as
      { Langfuse?: LangfuseCtor } | LangfuseCtor
    const Ctor: LangfuseCtor | undefined =
      typeof mod === "function"
        ? (mod as LangfuseCtor)
        : (mod as { Langfuse?: LangfuseCtor }).Langfuse
    if (typeof Ctor === "function") {
      cachedCtor = Ctor
      return Ctor
    }
  } catch {
    // langfuse package not installed — silently fall back to no-op.
  }
  return null
}

function hasMinimumCredentials(config: LangfuseConfig): boolean {
  return Boolean(
    typeof config.publicKey === "string" &&
    config.publicKey.trim().length > 0 &&
    typeof config.secretKey === "string" &&
    config.secretKey.trim().length > 0
  )
}

let cachedClient: MinimalLangfuseClient | null = null
let cachedConfigKey: string | null = null

function configKey(config: LangfuseConfig): string {
  return JSON.stringify({
    publicKey: config.publicKey || "",
    secretKey: config.secretKey || "",
    host: config.host || "",
  })
}

/**
 * Resolve a Langfuse client. Returns a real client when the SDK is available
 * AND credentials are present; returns the shared no-op client otherwise.
 *
 * The resolved client is memoized per credential triple so the langfuse
 * transport doesn't re-instantiate on every flush.
 */
export async function getLangfuse(config: LangfuseConfig): Promise<MinimalLangfuseClient> {
  const key = configKey(config)
  if (cachedClient && cachedConfigKey === key) {
    return cachedClient
  }

  if (!hasMinimumCredentials(config)) {
    cachedClient = NOOP_CLIENT
    cachedConfigKey = key
    return NOOP_CLIENT
  }

  const Ctor = await resolveLangfuseCtor()
  if (!Ctor) {
    cachedClient = NOOP_CLIENT
    cachedConfigKey = key
    return NOOP_CLIENT
  }

  try {
    const client = new Ctor({
      publicKey: config.publicKey,
      secretKey: config.secretKey,
      ...(config.host ? { baseUrl: config.host } : {}),
    })
    cachedClient = client
    cachedConfigKey = key
    return client
  } catch {
    cachedClient = NOOP_CLIENT
    cachedConfigKey = key
    return NOOP_CLIENT
  }
}

/**
 * Create a "chat trace" — a Langfuse trace tagged with chat-relevant
 * metadata. Accepts the data argument directly to match the langfuse
 * transport's call site.
 *
 * Note: callers pass the data record they want attached. We resolve the
 * shared client lazily so this module doesn't keep a stale Langfuse handle
 * after the user rotates credentials.
 */
export async function createChatTrace(data: Record<string, unknown>): Promise<MinimalTrace> {
  const client = await getLangfuse({})
  return client.trace(data)
}

/** Wraps `LangfuseTrace.span()` for symmetry with `createChatTrace`. */
export function createSpan(trace: MinimalTrace, data: Record<string, unknown>): MinimalGenOrSpan {
  return trace.span(data)
}

/** Test-only: clears the memoized client so a re-resolve can happen. */
export function resetLangfuseClientForTest(): void {
  cachedClient = null
  cachedConfigKey = null
  cachedCtor = null
  resolveAttempted = false
}
