/**
 * The live smoke's hold on the network (ADR-0188 D20; handoff rule 14).
 *
 * A dry run and a simulated run must not reach any provider, and "must not"
 * is enforced, not assumed: in `block` mode the process's `fetch` is replaced
 * by one that refuses every request and records it, so a stray call anywhere
 * in the engine fails loudly and shows up in the report as a blocked request.
 *
 * A confirmed live run uses `observe` mode instead: requests pass through
 * unchanged and are counted, so the report can compare the requests on the
 * wire with the calls the executor made — a retry hidden inside an SDK would
 * be the difference (the executor runs every call with `maxRetries: 0`).
 *
 * The provider SDKs read `globalThis.fetch` at call time, so both modes see
 * their traffic. `restore()` puts the original back.
 */

export type NetworkGuardMode = "block" | "observe"

export interface NetworkRecord {
  method: string
  host: string
  /** Scheme, host and path; the query string is dropped (it can carry a key). */
  url: string
  status: number | null
  durationMs: number
  retryAfter: string | null
  blocked: boolean
}

export interface NetworkGuard {
  readonly mode: NetworkGuardMode
  /** Every request so far, in order. */
  readonly records: readonly NetworkRecord[]
  restore(): void
}

export class LiveSmokeNetworkBlockedError extends Error {
  constructor(url: string) {
    super(
      `the live smoke blocked a network request in a run that may not reach the network: ${url}`
    )
    this.name = "LiveSmokeNetworkBlockedError"
  }
}

type FetchFunction = (input: unknown, init?: { method?: string }) => Promise<unknown>

export interface NetworkGuardDeps {
  now: () => number
  /** The object whose `fetch` is guarded; the global object by default. */
  target?: { fetch?: unknown }
}

function describe(input: unknown, init?: { method?: string }): { url: string; method: string } {
  let raw = ""
  let method = init?.method
  if (typeof input === "string") raw = input
  else if (input instanceof URL) raw = input.href
  else if (input && typeof input === "object" && "url" in input) {
    raw = String((input as { url: unknown }).url)
    method ??= (input as { method?: string }).method
  }
  let url = raw
  try {
    const parsed = new URL(raw)
    url = `${parsed.protocol}//${parsed.host}${parsed.pathname}`
  } catch {
    // Not an absolute URL: keep it as given, minus any query.
    url = raw.split("?")[0]
  }
  return { url, method: (method ?? "GET").toUpperCase() }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ""
  }
}

export function installNetworkGuard(mode: NetworkGuardMode, deps: NetworkGuardDeps): NetworkGuard {
  const target = (deps.target ?? globalThis) as { fetch?: unknown }
  const hadOwn = Object.prototype.hasOwnProperty.call(target, "fetch")
  const original = target.fetch as FetchFunction | undefined
  const records: NetworkRecord[] = []

  const guarded: FetchFunction = async (input, init) => {
    const { url, method } = describe(input, init)
    const startedAt = deps.now()
    if (mode === "block" || typeof original !== "function") {
      records.push({
        method,
        host: hostOf(url),
        url,
        status: null,
        durationMs: 0,
        retryAfter: null,
        blocked: true,
      })
      throw new LiveSmokeNetworkBlockedError(url)
    }
    const record: NetworkRecord = {
      method,
      host: hostOf(url),
      url,
      status: null,
      durationMs: 0,
      retryAfter: null,
      blocked: false,
    }
    records.push(record)
    try {
      const response = (await original.call(target, input, init)) as {
        status?: number
        headers?: { get?: (name: string) => string | null }
      }
      record.status = typeof response?.status === "number" ? response.status : null
      record.retryAfter = response?.headers?.get?.("retry-after") ?? null
      return response
    } finally {
      record.durationMs = deps.now() - startedAt
    }
  }
  target.fetch = guarded

  let restored = false
  return {
    mode,
    records,
    restore() {
      if (restored) return
      restored = true
      if (hadOwn) target.fetch = original
      else delete target.fetch
    },
  }
}
