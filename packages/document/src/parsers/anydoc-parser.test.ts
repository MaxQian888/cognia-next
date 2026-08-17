import type { AnyDocWorkerRequest, AnyDocWorkerResponse } from "./anydoc-worker"
import {
  ANYDOC_VERSION,
  AnyDocParseError,
  AnyDocParser,
  parseLegacyOfficeWithAnyDoc,
} from "./anydoc-parser"

class FakeWorker {
  static instances: FakeWorker[] = []

  readonly requests: AnyDocWorkerRequest[] = []
  readonly transferred: ArrayBuffer[] = []
  terminated = false
  throwOnPost = false
  private readonly listeners = new Map<string, Array<(event: MessageEvent | ErrorEvent) => void>>()

  constructor() {
    FakeWorker.instances.push(this)
  }

  addEventListener(type: string, listener: (event: MessageEvent | ErrorEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  postMessage(request: AnyDocWorkerRequest, transfer: Transferable[]): void {
    if (this.throwOnPost) throw new Error("post failed")
    this.transferred.push(...(transfer as ArrayBuffer[]))
    this.requests.push(structuredClone(request, { transfer }))
  }

  respond(response: AnyDocWorkerResponse): void {
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ data: response } as MessageEvent<AnyDocWorkerResponse>)
    }
  }

  fail(message: string): void {
    for (const listener of this.listeners.get("error") ?? []) {
      listener({ message } as ErrorEvent)
    }
  }

  terminate(): void {
    this.terminated = true
  }
}

const workerFactory = (): Worker => new FakeWorker() as unknown as Worker

describe("AnyDocParser", () => {
  beforeEach(() => {
    FakeWorker.instances = []
  })

  it("transfers an owned copy and keeps the caller buffer usable", async () => {
    const parser = new AnyDocParser(workerFactory)
    const input = Uint8Array.from([1, 2, 3, 4]).buffer
    const pending = parser.parse(input, "doc")
    const worker = FakeWorker.instances[0]
    const request = worker.requests[0]

    expect(input.byteLength).toBe(4)
    expect(worker.transferred[0]).not.toBe(input)
    expect(worker.transferred[0].byteLength).toBe(0)
    expect(request.bytes.byteLength).toBe(4)

    worker.respond({
      type: "success",
      requestId: request.requestId,
      markdown: "# Parsed",
      detectedFormat: "doc",
    })

    await expect(pending).resolves.toEqual({
      markdown: "# Parsed",
      format: "doc",
      engineVersion: ANYDOC_VERSION,
    })
    expect(worker.terminated).toBe(true)
  })

  it("serializes jobs and gives each active parse a dedicated worker", async () => {
    const parser = new AnyDocParser(workerFactory)
    const firstPending = parser.parse(new ArrayBuffer(1), "doc")
    const secondPending = parser.parse(new ArrayBuffer(1), "ppt")
    const firstWorker = FakeWorker.instances[0]
    const firstRequest = firstWorker.requests[0]

    expect(FakeWorker.instances).toHaveLength(1)
    firstWorker.respond({
      type: "success",
      requestId: firstRequest.requestId,
      markdown: "first",
      detectedFormat: "doc",
    })
    await expect(firstPending).resolves.toMatchObject({ markdown: "first" })

    expect(FakeWorker.instances).toHaveLength(2)
    const secondWorker = FakeWorker.instances[1]
    const secondRequest = secondWorker.requests[0]
    secondWorker.respond({
      type: "success",
      requestId: secondRequest.requestId,
      markdown: "second",
      detectedFormat: "ppt",
    })
    await expect(secondPending).resolves.toMatchObject({ markdown: "second" })
    expect(firstWorker.terminated).toBe(true)
    expect(secondWorker.terminated).toBe(true)
  })

  it("maps stable worker failures without cloning upstream Error objects", async () => {
    const parser = new AnyDocParser(workerFactory)
    const pending = parser.parse(new ArrayBuffer(1), "doc")
    const worker = FakeWorker.instances[0]
    const request = worker.requests[0]

    worker.respond({
      type: "failure",
      requestId: request.requestId,
      engineCode: "encrypted",
      message: "Password required",
    })

    await expect(pending).rejects.toMatchObject({
      name: "AnyDocParseError",
      engineCode: "encrypted",
      diagnostic: { code: "password_protected", severity: "error" },
    })

    const missingAsset = parser.parse(new ArrayBuffer(1), "doc")
    const nextWorker = FakeWorker.instances[1]
    nextWorker.respond({
      type: "failure",
      requestId: nextWorker.requests[0].requestId,
      engineCode: "assetUnavailable",
      message: "WASM asset unavailable",
    })
    await expect(missingAsset).rejects.toMatchObject({
      engineCode: "assetUnavailable",
      diagnostic: { code: "unsupported_feature", severity: "error" },
    })
  })

  it("preserves detected format details for safe mismatch routing", async () => {
    const parser = new AnyDocParser(workerFactory)
    const pending = parser.parse(new ArrayBuffer(1), "doc")
    const worker = FakeWorker.instances[0]
    const request = worker.requests[0]

    worker.respond({
      type: "failure",
      requestId: request.requestId,
      engineCode: "formatMismatch",
      message: "The file is actually docx",
      detectedFormat: "docx",
    })

    await expect(pending).rejects.toMatchObject({
      engineCode: "formatMismatch",
      detectedFormat: "docx",
      diagnostic: { code: "parse_failed" },
    })
  })

  it("hard-cancels an active synchronous worker with AbortError", async () => {
    const parser = new AnyDocParser(workerFactory)
    const controller = new AbortController()
    const pending = parser.parse(new ArrayBuffer(1), "doc", { signal: controller.signal })
    const worker = FakeWorker.instances[0]

    controller.abort(new Error("user cancelled"))

    await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "user cancelled" })
    expect(worker.terminated).toBe(true)
  })

  it("removes an aborted queued job without interrupting the active job", async () => {
    const parser = new AnyDocParser(workerFactory)
    const active = parser.parse(new ArrayBuffer(1), "doc")
    const controller = new AbortController()
    const queued = parser.parse(new ArrayBuffer(1), "ppt", { signal: controller.signal })
    const worker = FakeWorker.instances[0]
    const request = worker.requests[0]

    controller.abort()
    await expect(queued).rejects.toMatchObject({ name: "AbortError" })
    expect(worker.terminated).toBe(false)

    worker.respond({
      type: "success",
      requestId: request.requestId,
      markdown: "active",
      detectedFormat: "doc",
    })
    await expect(active).resolves.toMatchObject({ markdown: "active" })
    expect(FakeWorker.instances).toHaveLength(1)
  })

  it("terminates a timed-out worker and ignores stale replies", async () => {
    jest.useFakeTimers()
    try {
      const parser = new AnyDocParser(workerFactory)
      const pending = parser.parse(new ArrayBuffer(1), "doc", { timeoutMs: 25 })
      const worker = FakeWorker.instances[0]
      const request = worker.requests[0]

      worker.respond({
        type: "success",
        requestId: "stale-request",
        markdown: "wrong",
        detectedFormat: "doc",
      })
      jest.advanceTimersByTime(25)

      await expect(pending).rejects.toMatchObject({ engineCode: "timeout" })
      expect(worker.terminated).toBe(true)

      worker.respond({
        type: "success",
        requestId: request.requestId,
        markdown: "too late",
        detectedFormat: "doc",
      })
    } finally {
      jest.useRealTimers()
    }
  })

  it("normalizes worker construction, posting, and runtime failures", async () => {
    const unavailable = new AnyDocParser(() => {
      throw new Error("worker unavailable")
    })
    await expect(unavailable.parse(new ArrayBuffer(1), "doc")).rejects.toMatchObject({
      engineCode: "initFailed",
      diagnostic: { code: "unsupported_feature" },
    })

    const postFailure = new AnyDocParser(() => {
      const worker = new FakeWorker()
      worker.throwOnPost = true
      return worker as unknown as Worker
    })
    await expect(postFailure.parse(new ArrayBuffer(1), "doc")).rejects.toMatchObject({
      engineCode: "workerCrashed",
    })

    const crashed = new AnyDocParser(workerFactory)
    const pending = crashed.parse(new ArrayBuffer(1), "doc")
    FakeWorker.instances.at(-1)?.fail("runtime crash")
    await expect(pending).rejects.toMatchObject({
      engineCode: "workerCrashed",
      message: "runtime crash",
    })
  })

  it("rejects already-aborted and over-limit inputs before creating a worker", async () => {
    const parser = new AnyDocParser(workerFactory)
    const controller = new AbortController()
    controller.abort()

    await expect(
      parser.parse(new ArrayBuffer(1), "doc", { signal: controller.signal })
    ).rejects.toMatchObject({ name: "AbortError" })
    await expect(parser.parse(new ArrayBuffer(10 * 1024 * 1024 + 1), "doc")).rejects.toMatchObject({
      engineCode: "resourceLimit",
      diagnostic: { code: "parse_failed" },
    })
    expect(FakeWorker.instances).toHaveLength(0)
  })

  it("validates timeout options before enqueueing work", async () => {
    const parser = new AnyDocParser(workerFactory)

    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 60_001]) {
      await expect(parser.parse(new ArrayBuffer(1), "doc", { timeoutMs })).rejects.toMatchObject({
        engineCode: "resourceLimit",
      })
    }
    expect(FakeWorker.instances).toHaveLength(0)
  })

  it("bounds retained input across active and queued jobs", async () => {
    const parser = new AnyDocParser(workerFactory)
    const activeController = new AbortController()
    const queuedController = new AbortController()
    const active = parser.parse(new ArrayBuffer(10 * 1024 * 1024), "doc", {
      signal: activeController.signal,
    })
    const queued = parser.parse(new ArrayBuffer(10 * 1024 * 1024), "ppt", {
      signal: queuedController.signal,
    })

    await expect(parser.parse(new ArrayBuffer(1), "doc")).rejects.toMatchObject({
      engineCode: "resourceLimit",
    })

    queuedController.abort()
    activeController.abort()
    await expect(queued).rejects.toMatchObject({ name: "AbortError" })
    await expect(active).rejects.toMatchObject({ name: "AbortError" })
  })

  it("keeps an existing AnyDocParseError from the worker factory", async () => {
    const expected = new AnyDocParseError("blocked", "initFailed")
    const parser = new AnyDocParser(() => {
      throw expected
    })

    await expect(parser.parse(new ArrayBuffer(1), "doc")).rejects.toBe(expected)
  })

  it("reports an initialization error through the public singleton when Worker is unavailable", async () => {
    const previousWorker = globalThis.Worker
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: undefined })
    try {
      await expect(parseLegacyOfficeWithAnyDoc(new ArrayBuffer(1), "doc")).rejects.toMatchObject({
        engineCode: "initFailed",
        diagnostic: { code: "unsupported_feature" },
      })
    } finally {
      Object.defineProperty(globalThis, "Worker", { configurable: true, value: previousWorker })
    }
  })
})
