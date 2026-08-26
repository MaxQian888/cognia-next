/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { IDBFactory } from "fake-indexeddb"
import {
  RemoteTransport,
  createRemoteTransport,
  sentryTransform,
  logglyTransform,
  type RemoteTransportOptions,
} from "./remote-transport"
import type { RemoteRetryQueueBatch, RemoteRetryQueueStore } from "./remote-retry-queue-store"
import type { StructuredLogEntry } from "../types"

let activeFetch: jest.Mock | undefined

function makeEntry(overrides: Partial<StructuredLogEntry> = {}): StructuredLogEntry {
  return {
    id: overrides.id ?? "log-1",
    timestamp: overrides.timestamp ?? "2026-04-30T10:00:00.000Z",
    level: overrides.level ?? "info",
    message: overrides.message ?? "hello",
    module: overrides.module ?? "test",
    ...overrides,
  }
}

class FakeQueueStore implements RemoteRetryQueueStore {
  batches: RemoteRetryQueueBatch[] = []
  nextId = 1
  enqueueShouldThrow = false
  limits = { maxEntries: 100, maxBytes: 1024 * 1024 }

  async enqueueBatch(entries: StructuredLogEntry[]) {
    if (this.enqueueShouldThrow) {
      throw new Error("queue full")
    }
    let dropped = 0
    let droppedBatches = 0
    const bytes = JSON.stringify(entries).length
    this.batches.push({
      id: this.nextId++,
      createdAt: new Date().toISOString(),
      entries: [...entries],
      bytes,
    })
    while (this.batches.reduce((s, b) => s + b.entries.length, 0) > this.limits.maxEntries) {
      const drop = this.batches.shift()
      if (!drop) break
      dropped += drop.entries.length
      droppedBatches += 1
    }
    return {
      droppedEntries: dropped,
      droppedBatches,
      stats: this.computeStats(),
    }
  }

  async listBatches() {
    return this.batches.map((b) => ({ ...b, entries: [...b.entries] }))
  }

  async deleteBatch(id: number) {
    this.batches = this.batches.filter((b) => b.id !== id)
  }

  async getStats() {
    return this.computeStats()
  }

  async clear() {
    this.batches = []
  }

  updateLimits(limits: Partial<typeof this.limits>) {
    this.limits = {
      maxEntries: limits.maxEntries ?? this.limits.maxEntries,
      maxBytes: limits.maxBytes ?? this.limits.maxBytes,
    }
  }

  async close() {}

  private computeStats() {
    return this.batches.reduce(
      (acc, b) => {
        acc.batchCount += 1
        acc.entryCount += b.entries.length
        acc.totalBytes += b.bytes
        return acc
      },
      { batchCount: 0, entryCount: 0, totalBytes: 0 }
    )
  }
}

beforeEach(() => {
  activeFetch = undefined
  // Each test gets a fresh in-memory IDB factory (the default queue store
  // will use this if no explicit queueStore option is provided).
  const factory = new IDBFactory()
  ;(globalThis as { indexedDB: IDBFactory }).indexedDB = factory
  ;(window as unknown as { indexedDB: IDBFactory }).indexedDB = factory

  // Online by default for predictable tests.
  Object.defineProperty(window.navigator, "onLine", {
    value: true,
    configurable: true,
    writable: true,
  })
})

function withFetch(
  responder: () => MinimalResponse | Promise<MinimalResponse> | Promise<never>
): jest.Mock {
  const fn = jest.fn(async () => responder())
  activeFetch = fn
  return fn
}

interface MinimalResponse {
  ok: boolean
  status: number
  statusText: string
  headers: { get: (k: string) => string | null }
  json: () => Promise<unknown>
  text: () => Promise<string>
}

function okResponse(): MinimalResponse {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => "application/json" },
    json: async () => ({}),
    text: async () => "{}",
  }
}

function badResponse(status = 500, statusText = "boom"): MinimalResponse {
  return {
    ok: false,
    status,
    statusText,
    headers: { get: () => null },
    json: async () => ({}),
    text: async () => "err",
  }
}

function makeTransport(opts: Partial<RemoteTransportOptions> = {}, store?: FakeQueueStore) {
  return new RemoteTransport({
    endpoint: "https://example.com/logs",
    batchSize: opts.batchSize ?? 100,
    flushInterval: opts.flushInterval ?? 60_000,
    maxRetries: opts.maxRetries ?? 0,
    retryDelay: opts.retryDelay ?? 1,
    timeout: opts.timeout ?? 5_000,
    transform: opts.transform,
    privacyPredicate: opts.privacyPredicate ?? (() => true),
    diagnosticEmitter: opts.diagnosticEmitter,
    fetchImpl: opts.fetchImpl ?? (activeFetch as typeof fetch | undefined),
    queueStore: store,
    diagnosticRateLimitMs: opts.diagnosticRateLimitMs,
  })
}

describe("RemoteTransport happy path", () => {
  it("uses the injected platform sender instead of direct WebView fetch", async () => {
    const platformFetch = jest.fn(async () => okResponse())
    const directFetch = withFetch(() => Promise.reject(new Error("direct fetch must not run")))
    const transport = makeTransport({ fetchImpl: platformFetch as typeof fetch })

    transport.log(makeEntry())
    await transport.flush()

    expect(platformFetch).toHaveBeenCalledTimes(1)
    expect(directFetch).not.toHaveBeenCalled()
  })

  it("buffers and POSTs entries on flush", async () => {
    const store = new FakeQueueStore()
    const fetchMock = withFetch(() => okResponse())
    const t = makeTransport({}, store)
    t.log(makeEntry({ id: "a" }))
    t.log(makeEntry({ id: "b" }))
    await t.flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body.map((e: StructuredLogEntry) => e.id)).toEqual(["a", "b"])
    await t.close()
  })

  it("auto-flushes when batchSize reached", async () => {
    const store = new FakeQueueStore()
    const fetchMock = withFetch(() => okResponse())
    const t = makeTransport({ batchSize: 1 }, store)
    t.log(makeEntry({ id: "a" }))
    // Drain microtasks to let `void this.flush()` finish.
    await new Promise((r) => setTimeout(r, 10))
    expect(fetchMock).toHaveBeenCalled()
    await t.close()
  })

  it("calls custom transform fn before sending", async () => {
    const store = new FakeQueueStore()
    const fetchMock = withFetch(() => okResponse())
    const transform = jest.fn(() => ({ wrapped: true }))
    const t = makeTransport({ transform }, store)
    t.log(makeEntry())
    await t.flush()
    expect(transform).toHaveBeenCalled()
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ wrapped: true })
    await t.close()
  })

  it("fails closed at the final serialized-body privacy gate", async () => {
    const store = new FakeQueueStore()
    const fetchMock = withFetch(() => okResponse())
    const diagnosticEmitter = jest.fn()
    const privacyPredicate = jest.fn((body: string) => !body.includes("alice@example.com"))
    const t = makeTransport({ diagnosticEmitter, privacyPredicate }, store)
    t.log(makeEntry({ message: "email alice@example.com" }))
    await t.flush()

    expect(privacyPredicate).toHaveBeenCalledWith(expect.stringContaining("alice@example.com"))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(store.batches).toHaveLength(0)
    expect(t.getHealth()).toMatchObject({
      droppedEntries: 1,
      lastError: "Remote log payload rejected by privacy gate",
    })
    expect(diagnosticEmitter).toHaveBeenCalledWith(
      expect.objectContaining({ code: "logger.remote.privacy_rejected" })
    )
    await t.close()
  })

  it("drops only the leaking entry, not the clean ones batched beside it", async () => {
    const store = new FakeQueueStore()
    const fetchMock = withFetch(() => okResponse())
    const t = makeTransport(
      { privacyPredicate: (body: string) => !body.includes("alice@example.com") },
      store
    )
    t.log(makeEntry({ message: "before" }))
    t.log(makeEntry({ message: "email alice@example.com" }))
    t.log(makeEntry({ message: "after" }))
    await t.flush()

    // The batch is deleted from the durable queue either way, so anything not
    // shipped here is gone for good — the two clean entries must go out.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = String((fetchMock.mock.calls[0][1] as RequestInit).body)
    expect(body).toContain("before")
    expect(body).toContain("after")
    expect(body).not.toContain("alice@example.com")
    expect(t.getHealth()).toMatchObject({ droppedEntries: 1 })
    await t.close()
  })

  it("getHealth reports healthy after success", async () => {
    const store = new FakeQueueStore()
    withFetch(() => okResponse())
    const t = makeTransport({}, store)
    t.log(makeEntry())
    await t.flush()
    expect(t.getHealth().status).toBe("healthy")
    await t.close()
  })

  it("flush returns early when buffer is empty (no fetch)", async () => {
    const store = new FakeQueueStore()
    const fetchMock = withFetch(() => okResponse())
    const t = makeTransport({}, store)
    await t.flush()
    expect(fetchMock).not.toHaveBeenCalled()
    await t.close()
  })
})

describe("RemoteTransport failure modes", () => {
  it("retries with backoff and enqueues on persistent failure", async () => {
    const store = new FakeQueueStore()
    const fetchMock = withFetch(() => Promise.reject(new Error("network down")))
    const diagnosticEmitter = jest.fn()
    const t = makeTransport({ maxRetries: 2, retryDelay: 1, diagnosticEmitter }, store)
    t.log(makeEntry())
    await t.flush()
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(store.batches.length).toBe(1)
    expect(diagnosticEmitter).toHaveBeenCalled()
    await t.close()
  })

  it("treats non-2xx response as failure (single batch enqueued)", async () => {
    const store = new FakeQueueStore()
    withFetch(() => badResponse(500, "boom"))
    const t = makeTransport({ maxRetries: 0, retryDelay: 1 }, store)
    t.log(makeEntry())
    await t.flush()
    expect(store.batches.length).toBe(1)
    await t.close()
  })

  it("emits queue_overflow diagnostic when batches dropped", async () => {
    const store = new FakeQueueStore()
    withFetch(() => badResponse(500))
    const diagnosticEmitter = jest.fn()
    // The transport calls store.updateLimits() with the maxQueueEntries
    // option in its constructor, so we must pass that here (setting
    // store.limits beforehand is overwritten).
    const t = new RemoteTransport({
      endpoint: "https://example.com/logs",
      batchSize: 100,
      flushInterval: 60_000,
      maxRetries: 0,
      retryDelay: 1,
      privacyPredicate: () => true,
      maxQueueEntries: 1,
      diagnosticEmitter,
      diagnosticRateLimitMs: 250,
      queueStore: store,
    })
    t.log(makeEntry({ id: "a" }))
    await t.flush()
    await new Promise((r) => setTimeout(r, 300))
    t.log(makeEntry({ id: "b" }))
    await t.flush()
    const codes = diagnosticEmitter.mock.calls.map((c) => c[0].code)
    expect(codes).toContain("logger.remote.queue_overflow")
    await t.close()
  })

  it("emits queue_write_failed when queueStore.enqueueBatch throws", async () => {
    const store = new FakeQueueStore()
    store.enqueueShouldThrow = true
    withFetch(() => badResponse())
    const diagnosticEmitter = jest.fn()
    const t = makeTransport({ maxRetries: 0, retryDelay: 1, diagnosticEmitter }, store)
    t.log(makeEntry())
    await t.flush()
    const codes = diagnosticEmitter.mock.calls.map((c) => c[0].code)
    expect(codes).toContain("logger.remote.queue_write_failed")
    await t.close()
  })
})

describe("RemoteTransport offline behavior", () => {
  it("starts healthy when navigator exists but has no onLine (Node >= 26)", async () => {
    // Node 26 ships a global `navigator` without `onLine`; reading it as falsy
    // would boot the transport permanently "offline" in CLI/sidecar runs.
    const original = Object.getOwnPropertyDescriptor(window.navigator, "onLine")
    Object.defineProperty(window.navigator, "onLine", {
      value: undefined,
      configurable: true,
      writable: true,
    })
    try {
      const store = new FakeQueueStore()
      const fetchMock = withFetch(() => okResponse())
      const t = makeTransport({}, store)
      expect(t.getHealth().status).not.toBe("offline")
      t.log(makeEntry())
      await t.flush()
      expect(fetchMock).toHaveBeenCalled()
      await t.close()
    } finally {
      if (original) Object.defineProperty(window.navigator, "onLine", original)
    }
  })

  it("queues entries when offline (no fetch attempted)", async () => {
    Object.defineProperty(window.navigator, "onLine", {
      value: false,
      configurable: true,
      writable: true,
    })
    const store = new FakeQueueStore()
    const fetchMock = withFetch(() => okResponse())
    const t = makeTransport({}, store)
    t.log(makeEntry())
    await t.flush()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(store.batches.length).toBe(1)
    expect(t.getHealth().status).toBe("offline")
    await t.close()
  })

  it("emits 'offline' diagnostic when going offline event fires", async () => {
    const store = new FakeQueueStore()
    withFetch(() => okResponse())
    const diagnosticEmitter = jest.fn()
    const t = makeTransport({ diagnosticEmitter }, store)
    Object.defineProperty(window.navigator, "onLine", {
      value: false,
      configurable: true,
      writable: true,
    })
    window.dispatchEvent(new Event("offline"))
    expect(diagnosticEmitter).toHaveBeenCalledWith(
      expect.objectContaining({ code: "logger.remote.offline" })
    )
    await t.close()
  })

  it("flushes the retry queue when going back online", async () => {
    const store = new FakeQueueStore()
    // Pre-populate the queue while offline.
    Object.defineProperty(window.navigator, "onLine", {
      value: false,
      configurable: true,
      writable: true,
    })
    const fetchMock = withFetch(() => okResponse())
    const t = makeTransport({}, store)
    t.log(makeEntry())
    await t.flush()
    expect(store.batches.length).toBe(1)
    expect(fetchMock).not.toHaveBeenCalled()

    // Go back online via the event listener.
    Object.defineProperty(window.navigator, "onLine", {
      value: true,
      configurable: true,
      writable: true,
    })
    window.dispatchEvent(new Event("online"))
    // The handler invokes `void flushRetryQueue()`. Drain its microtasks.
    await new Promise((r) => setTimeout(r, 30))
    expect(fetchMock).toHaveBeenCalled()
    expect(store.batches.length).toBe(0)
    await t.close()
  })
})

describe("RemoteTransport recovery", () => {
  it("emits 'recovered' diagnostic after a queued batch is drained", async () => {
    const store = new FakeQueueStore()
    // Pre-queue a batch up-front.
    await store.enqueueBatch([makeEntry({ id: "stale" })])
    const fetchMock = withFetch(() => okResponse())
    const diagnosticEmitter = jest.fn()
    const t = makeTransport({ diagnosticEmitter }, store)
    // Wait for initialize() to drain the pre-existing batch.
    await new Promise((r) => setTimeout(r, 30))
    const codes = diagnosticEmitter.mock.calls.map((c) => c[0].code)
    expect(codes).toContain("logger.remote.recovered")
    expect(fetchMock).toHaveBeenCalled()
    await t.close()
  })

  it("rate-limits identical diagnostic codes within the cooldown window", async () => {
    const store = new FakeQueueStore()
    withFetch(() => badResponse(500))
    const diagnosticEmitter = jest.fn()
    const t = makeTransport(
      { diagnosticEmitter, diagnosticRateLimitMs: 60_000, maxRetries: 0 },
      store
    )
    t.log(makeEntry({ id: "a" }))
    await t.flush()
    t.log(makeEntry({ id: "b" }))
    await t.flush()
    const sendFailures = diagnosticEmitter.mock.calls.filter(
      (c) => c[0].code === "logger.remote.send_failed"
    )
    expect(sendFailures.length).toBe(1)
    await t.close()
  })

  it("getPendingCount sums buffer + queueDepth", async () => {
    const store = new FakeQueueStore()
    withFetch(() => badResponse())
    const t = makeTransport({}, store)
    t.log(makeEntry({ id: "a" }))
    await t.flush()
    t.log(makeEntry({ id: "buffered" }))
    expect(t.getPendingCount()).toBeGreaterThan(0)
    await t.close()
  })

  it("close() removes online/offline listeners without errors", async () => {
    const store = new FakeQueueStore()
    withFetch(() => okResponse())
    const t = makeTransport({}, store)
    await t.close()
    Object.defineProperty(window.navigator, "onLine", {
      value: false,
      configurable: true,
      writable: true,
    })
    window.dispatchEvent(new Event("offline"))
  })
})

describe("RemoteTransport retry queue draining", () => {
  it("re-applies the privacy gate and deletes an unsafe persisted replay", async () => {
    const store = new FakeQueueStore()
    await store.enqueueBatch([makeEntry({ message: "email alice@example.com" })])
    const fetchMock = withFetch(() => okResponse())
    const t = makeTransport({ privacyPredicate: () => false }, store)

    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(store.batches).toHaveLength(0)
    expect(t.getHealth().droppedEntries).toBe(1)
    await t.close()
  })

  it("stops draining the queue if a batch fails mid-drain", async () => {
    const store = new FakeQueueStore()
    await store.enqueueBatch([makeEntry({ id: "first" })])
    await store.enqueueBatch([makeEntry({ id: "second" })])
    let callCount = 0
    withFetch(() => {
      callCount += 1
      if (callCount === 1) return okResponse()
      return badResponse()
    })
    const t = makeTransport({ maxRetries: 0, retryDelay: 1 }, store)
    // Wait for initialize() + flushRetryQueue to run.
    await new Promise((r) => setTimeout(r, 30))
    // First batch drained, second remains.
    expect(store.batches.length).toBe(1)
    expect(store.batches[0].entries[0].id).toBe("second")
    await t.close()
  })

  it("flushRetryQueue is a no-op when offline (during initialize)", async () => {
    Object.defineProperty(window.navigator, "onLine", {
      value: false,
      configurable: true,
      writable: true,
    })
    const store = new FakeQueueStore()
    await store.enqueueBatch([makeEntry({ id: "stale" })])
    const fetchMock = withFetch(() => okResponse())
    const t = makeTransport({}, store)
    await new Promise((r) => setTimeout(r, 30))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(store.batches.length).toBe(1)
    await t.close()
  })
})

describe("RemoteTransport flushTimer", () => {
  it("auto-flushes on the scheduled interval", async () => {
    const store = new FakeQueueStore()
    const fetchMock = withFetch(() => okResponse())
    const t = makeTransport({ flushInterval: 50 }, store)
    t.log(makeEntry())
    await new Promise((r) => setTimeout(r, 80))
    expect(fetchMock).toHaveBeenCalled()
    await t.close()
  })
})

describe("createRemoteTransport factory", () => {
  it("returns a RemoteTransport instance", () => {
    const t = createRemoteTransport({
      endpoint: "https://example.com/logs",
      privacyPredicate: () => true,
    })
    expect(t).toBeInstanceOf(RemoteTransport)
    expect(t.name).toBe("remote")
    void t.close()
  })
})

describe("sentryTransform / logglyTransform", () => {
  it("sentryTransform maps level + tags + extras", () => {
    const out = sentryTransform([
      makeEntry({
        level: "fatal",
        traceId: "tid",
        sessionId: "sid",
        tags: ["alpha"],
        data: { extra: 1 },
      }),
    ]) as Array<{ level: string; tags: Record<string, boolean>; extra: Record<string, unknown> }>
    expect(out[0].level).toBe("fatal")
    expect(out[0].tags).toMatchObject({ module: "test", alpha: true })
    expect(out[0].extra).toMatchObject({
      module: "test",
      traceId: "tid",
      sessionId: "sid",
      extra: 1,
    })
  })

  it("sentryTransform handles entries without tags", () => {
    const out = sentryTransform([makeEntry({ level: "info" })]) as Array<{
      level: string
      tags: Record<string, boolean>
    }>
    expect(out[0].level).toBe("info")
    expect(out[0].tags).toEqual({ module: "test" })
  })

  it("logglyTransform produces flat objects with module-as-tag", () => {
    const out = logglyTransform([
      makeEntry({ traceId: "tid", sessionId: "sid", data: { x: 1 } }),
    ]) as Array<{ tag: string; data: unknown }>
    expect(out[0].tag).toBe("test")
    expect(out[0].data).toEqual({ x: 1 })
  })
})
