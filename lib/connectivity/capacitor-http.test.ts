/** @jest-environment node */

import {
  getCapacitorHttp,
  capacitorHttpGet,
  combineAbortSignals,
  type CapacitorHttpPlugin,
  type CapacitorHttpResponse,
} from "./capacitor-http"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlugin(override?: Partial<CapacitorHttpPlugin>): CapacitorHttpPlugin {
  return {
    request: jest.fn(
      async (): Promise<CapacitorHttpResponse> => ({
        data: "ok",
        status: 200,
        headers: {},
        url: "https://example.com",
      })
    ),
    ...override,
  }
}

function injectCapacitor(plugin: CapacitorHttpPlugin | null) {
  const g = globalThis as unknown as Record<string, unknown>
  if (plugin === null) {
    delete g.Capacitor
  } else {
    g.Capacitor = {
      isNativePlatform: () => true,
      Plugins: { CapacitorHttp: plugin },
    }
  }
}

function clearCapacitor() {
  const g = globalThis as unknown as Record<string, unknown>
  delete g.Capacitor
}

// ---------------------------------------------------------------------------
// getCapacitorHttp
// ---------------------------------------------------------------------------

describe("getCapacitorHttp", () => {
  afterEach(() => {
    clearCapacitor()
  })

  it("returns null when globalThis.Capacitor is absent (web/test environment)", () => {
    clearCapacitor()
    expect(getCapacitorHttp()).toBeNull()
  })

  it("returns null when isNativePlatform() returns false", () => {
    const g = globalThis as unknown as Record<string, unknown>
    g.Capacitor = {
      isNativePlatform: () => false,
      Plugins: { CapacitorHttp: makePlugin() },
    }
    expect(getCapacitorHttp()).toBeNull()
  })

  it("returns null when Plugins.CapacitorHttp is undefined even on a native platform", () => {
    const g = globalThis as unknown as Record<string, unknown>
    g.Capacitor = {
      isNativePlatform: () => true,
      Plugins: {},
    }
    expect(getCapacitorHttp()).toBeNull()
  })

  it("returns null when Plugins itself is missing", () => {
    const g = globalThis as unknown as Record<string, unknown>
    g.Capacitor = { isNativePlatform: () => true }
    expect(getCapacitorHttp()).toBeNull()
  })

  it("returns the plugin when Capacitor is native and CapacitorHttp is present", () => {
    const plugin = makePlugin()
    injectCapacitor(plugin)
    expect(getCapacitorHttp()).toBe(plugin)
  })
})

// ---------------------------------------------------------------------------
// capacitorHttpGet — happy path
// ---------------------------------------------------------------------------

describe("capacitorHttpGet — happy path", () => {
  it("calls plugin.request with correct GET parameters and returns {status, data}", async () => {
    const plugin = makePlugin()
    const ctrl = new AbortController()
    const result = await capacitorHttpGet(plugin, "https://10.0.0.1:7890", {
      signal: ctrl.signal,
      timeoutMs: 5000,
    })
    expect(result).toEqual({ status: 200, data: "ok" })
    expect(plugin.request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://10.0.0.1:7890",
        method: "GET",
        serverTrustMode: "self-signed",
        connectTimeout: 5000,
        readTimeout: 5000,
        responseType: "text",
      })
    )
  })

  it("passes a custom serverTrustMode through to the plugin", async () => {
    const plugin = makePlugin()
    const ctrl = new AbortController()
    await capacitorHttpGet(plugin, "https://10.0.0.1:7890", {
      signal: ctrl.signal,
      timeoutMs: 3000,
      serverTrustMode: "default",
    })
    expect(plugin.request).toHaveBeenCalledWith(
      expect.objectContaining({ serverTrustMode: "default" })
    )
  })

  it("forwards the response status and data fields", async () => {
    const plugin = makePlugin({
      request: jest.fn(async () => ({
        data: { hello: "world" },
        status: 201,
        headers: {},
        url: "https://example.com",
      })),
    })
    const ctrl = new AbortController()
    const result = await capacitorHttpGet(plugin, "https://example.com", {
      signal: ctrl.signal,
      timeoutMs: 2000,
    })
    expect(result).toEqual({ status: 201, data: { hello: "world" } })
  })
})

// ---------------------------------------------------------------------------
// capacitorHttpGet — timeout path
// ---------------------------------------------------------------------------

describe("capacitorHttpGet — timeout", () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it("returns null when the plugin does not resolve before timeoutMs elapses", async () => {
    const plugin = makePlugin({
      request: jest.fn(
        () =>
          new Promise<CapacitorHttpResponse>(() => {
            /* never resolves */
          })
      ),
    })
    const ctrl = new AbortController()
    const promise = capacitorHttpGet(plugin, "https://slow.host", {
      signal: ctrl.signal,
      timeoutMs: 1000,
    })
    jest.advanceTimersByTime(1001)
    const result = await promise
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// capacitorHttpGet — abort path
// ---------------------------------------------------------------------------

describe("capacitorHttpGet — abort", () => {
  it("returns null immediately when the signal is already aborted", async () => {
    const plugin = makePlugin({
      request: jest.fn(
        () =>
          new Promise<CapacitorHttpResponse>(() => {
            /* never resolves */
          })
      ),
    })
    const ctrl = new AbortController()
    ctrl.abort()
    const result = await capacitorHttpGet(plugin, "https://example.com", {
      signal: ctrl.signal,
      timeoutMs: 5000,
    })
    expect(result).toBeNull()
  })

  it("returns null when abort fires mid-request", async () => {
    const ctrl = new AbortController()
    const plugin = makePlugin({
      request: jest.fn(
        () =>
          new Promise<CapacitorHttpResponse>((resolve) => {
            // Resolve after a delay — the abort should race it.
            const t = setTimeout(
              () =>
                resolve({
                  data: "late",
                  status: 200,
                  headers: {},
                  url: "https://example.com",
                }),
              2000
            )
            ctrl.signal.addEventListener("abort", () => clearTimeout(t), { once: true })
          })
      ),
    })
    const promise = capacitorHttpGet(plugin, "https://example.com", {
      signal: ctrl.signal,
      timeoutMs: 10000,
    })
    ctrl.abort()
    const result = await promise
    expect(result).toBeNull()
  })

  it("returns null when the plugin rejects", async () => {
    const plugin = makePlugin({
      request: jest.fn(async () => {
        throw new Error("network unreachable")
      }),
    })
    const ctrl = new AbortController()
    const result = await capacitorHttpGet(plugin, "https://example.com", {
      signal: ctrl.signal,
      timeoutMs: 5000,
    })
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// combineAbortSignals
// ---------------------------------------------------------------------------

describe("combineAbortSignals", () => {
  it("returns an AbortSignal", () => {
    const a = new AbortController()
    const b = new AbortController()
    const combined = combineAbortSignals(a.signal, b.signal)
    expect(combined).toBeInstanceOf(AbortSignal)
  })

  it("is aborted when the parent is aborted", async () => {
    const parent = new AbortController()
    const local = new AbortController()
    const combined = combineAbortSignals(parent.signal, local.signal)
    parent.abort()
    // Give microtask queue a turn if AbortSignal.any uses async scheduling.
    await Promise.resolve()
    expect(combined.aborted).toBe(true)
  })

  it("is aborted when the local signal is aborted", async () => {
    const parent = new AbortController()
    const local = new AbortController()
    const combined = combineAbortSignals(parent.signal, local.signal)
    local.abort()
    await Promise.resolve()
    expect(combined.aborted).toBe(true)
  })

  it("is not aborted when neither child is aborted", () => {
    const parent = new AbortController()
    const local = new AbortController()
    const combined = combineAbortSignals(parent.signal, local.signal)
    expect(combined.aborted).toBe(false)
  })

  it("falls back to the local signal when AbortSignal.any is unavailable", async () => {
    // Temporarily hide AbortSignal.any.
    const original = (AbortSignal as { any?: unknown }).any
    delete (AbortSignal as { any?: unknown }).any
    try {
      const parent = new AbortController()
      const local = new AbortController()
      const combined = combineAbortSignals(parent.signal, local.signal)
      // Fallback returns local, so aborting local should abort combined.
      local.abort()
      await Promise.resolve()
      expect(combined.aborted).toBe(true)
    } finally {
      ;(AbortSignal as { any?: unknown }).any = original
    }
  })
})
