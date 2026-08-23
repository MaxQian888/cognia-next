const mockInvoke = jest.fn()

interface MockChannel<T> {
  onmessage: ((event: T) => void) | undefined
  __fire(event: T): void
}

const channelInstances: MockChannel<unknown>[] = []

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  Channel: class<T> {
    onmessage: ((event: T) => void) | undefined
    constructor() {
      this.onmessage = undefined
      channelInstances.push(this as unknown as MockChannel<unknown>)
    }
    __fire(event: T): void {
      this.onmessage?.(event)
    }
  },
}))

const mockIsTauri = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({
  isTauri: () => mockIsTauri(),
}))

import { createPlatformStreamingFetch } from "./platform-streaming-fetch"

type StreamEvent =
  | { kind: "chunk"; seq: number; bodyBase64: string }
  | { kind: "error"; message: string }
  | { kind: "end" }

function channel(): MockChannel<StreamEvent> {
  const instance = channelInstances[channelInstances.length - 1]
  if (!instance) throw new Error("no channel constructed")
  return instance as MockChannel<StreamEvent>
}

function fire(event: StreamEvent): void {
  channel().__fire(event)
}

function encode(text: string): string {
  return Buffer.from(text, "utf8").toString("base64")
}

function headOk(headers: Record<string, string> = {}) {
  return { requestId: "ignored", status: 200, headers }
}

/** Answer `proxy_http_stream_open` with a head; everything else resolves. */
function respondWithHead(head: ReturnType<typeof headOk>): void {
  mockInvoke.mockImplementation((command: string) => {
    if (command === "proxy_http_stream_open") return Promise.resolve(head)
    return Promise.resolve(true)
  })
}

async function readAll(response: Response): Promise<string> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let out = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
  }
  return out + decoder.decode()
}

beforeEach(() => {
  mockInvoke.mockReset()
  channelInstances.length = 0
  mockIsTauri.mockReset().mockReturnValue(true)
})

describe("createPlatformStreamingFetch on Tauri", () => {
  it("returns the response head before any body byte arrives", async () => {
    respondWithHead({
      requestId: "r",
      status: 401,
      headers: { "content-type": "application/json" },
    })

    const response = await createPlatformStreamingFetch()("https://api.example.com/events")

    expect(response.status).toBe(401)
    expect(response.headers.get("content-type")).toBe("application/json")
    // A caller must be able to reject a 401 without draining a body it will
    // discard, which is the whole reason `open` resolves on the head.
    expect(mockInvoke).toHaveBeenCalledWith("proxy_http_stream_open", {
      input: expect.objectContaining({ url: "https://api.example.com/events", method: "GET" }),
      onEvent: expect.anything(),
    })
  })

  it("delivers body chunks in order and closes on end", async () => {
    respondWithHead(headOk())
    const response = await createPlatformStreamingFetch()("https://api.example.com/events")

    const body = readAll(response)
    fire({ kind: "chunk", seq: 0, bodyBase64: encode("data: one\n\n") })
    fire({ kind: "chunk", seq: 1, bodyBase64: encode("data: two\n\n") })
    fire({ kind: "end" })

    expect(await body).toBe("data: one\n\ndata: two\n\n")
  })

  it("acknowledges each chunk it hands to the consumer", async () => {
    respondWithHead(headOk())
    const response = await createPlatformStreamingFetch()("https://api.example.com/events")

    const body = readAll(response)
    fire({ kind: "chunk", seq: 0, bodyBase64: encode("abcde") })
    fire({ kind: "end" })
    await body

    // The ack is the flow-control signal the native reader parks on; a
    // consumer that never acks would stall the stream after 4 MiB.
    expect(mockInvoke).toHaveBeenCalledWith("proxy_http_stream_ack", {
      requestId: expect.any(String),
      bytes: 5,
    })
  })

  it("surfaces a mid-stream error through the body, after the chunks that did arrive", async () => {
    respondWithHead(headOk())
    const response = await createPlatformStreamingFetch()("https://api.example.com/events")

    const reader = response.body!.getReader()
    fire({ kind: "chunk", seq: 0, bodyBase64: encode("partial") })
    fire({ kind: "error", message: "read body failed: connection reset" })
    fire({ kind: "end" })

    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe("partial")
    await expect(reader.read()).rejects.toThrow("connection reset")
  })

  it("rejects when the native open fails", async () => {
    mockInvoke.mockImplementation((command: string) =>
      command === "proxy_http_stream_open"
        ? Promise.reject(new Error("request failed: dns error"))
        : Promise.resolve(true)
    )

    await expect(createPlatformStreamingFetch()("https://api.example.com/events")).rejects.toThrow(
      "Proxy stream failed: request failed: dns error"
    )
  })

  it("throws AbortError without opening when the signal is already aborted", async () => {
    respondWithHead(headOk())
    const controller = new AbortController()
    controller.abort()

    await expect(
      createPlatformStreamingFetch()("https://api.example.com/events", {
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("cancels the native stream and errors the body when the signal fires mid-stream", async () => {
    respondWithHead(headOk())
    const controller = new AbortController()
    const response = await createPlatformStreamingFetch()("https://api.example.com/events", {
      signal: controller.signal,
    })

    const reader = response.body!.getReader()
    fire({ kind: "chunk", seq: 0, bodyBase64: encode("one") })
    await reader.read()
    controller.abort()

    // A clean close here would read to the caller as "the server finished",
    // which is the opposite of what an abort means.
    await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" })
    expect(mockInvoke).toHaveBeenCalledWith("proxy_http_stream_cancel", {
      requestId: expect.any(String),
    })
  })

  it("cancels the native stream when the consumer cancels the body", async () => {
    respondWithHead(headOk())
    const response = await createPlatformStreamingFetch()("https://api.example.com/events")

    await response.body!.cancel()

    expect(mockInvoke).toHaveBeenCalledWith("proxy_http_stream_cancel", {
      requestId: expect.any(String),
    })
  })

  it("returns a null body for statuses that must not carry one, and releases the stream", async () => {
    respondWithHead({ requestId: "r", status: 204, headers: {} })

    const response = await createPlatformStreamingFetch()("https://api.example.com/thing", {
      method: "DELETE",
    })

    expect(response.status).toBe(204)
    expect(response.body).toBeNull()
    // No body will ever arrive, so the native task must not stay parked.
    expect(mockInvoke).toHaveBeenCalledWith("proxy_http_stream_cancel", {
      requestId: expect.any(String),
    })
  })

  it("forwards the body, timeouts and SSRF guard to the native command", async () => {
    respondWithHead(headOk())

    await createPlatformStreamingFetch()("https://api.example.com/ingest", {
      method: "POST",
      body: "hello",
      headers: { authorization: "Bearer token" },
      connectTimeout: 5_000,
      readTimeout: 60_000,
      blockPrivateHosts: true,
    })

    const [, args] = mockInvoke.mock.calls[0] as [string, { input: Record<string, unknown> }]
    expect(args.input).toMatchObject({
      method: "POST",
      bodyBase64: encode("hello"),
      connectTimeoutMs: 5_000,
      readTimeoutMs: 60_000,
      blockPrivate: true,
    })
    expect((args.input.headers as Record<string, string>).authorization).toBe("Bearer token")
  })

  it("refuses to let a caller set Proxy-Authorization", async () => {
    respondWithHead(headOk())

    await expect(
      createPlatformStreamingFetch()("https://api.example.com/events", {
        headers: { "proxy-authorization": "Basic abc" },
      })
    ).rejects.toThrow("Proxy-Authorization is reserved for the native proxy connector")
  })

  it("omits blockPrivate entirely when the guard is off", async () => {
    respondWithHead(headOk())

    await createPlatformStreamingFetch()("http://127.0.0.1:11434/api/pull")

    const [, args] = mockInvoke.mock.calls[0] as [string, { input: Record<string, unknown> }]
    // `Some(false)` and `None` are the same to Rust here, but sending the key
    // at all would make a future "default on" change silently ineffective.
    expect("blockPrivate" in args.input).toBe(false)
  })
})

describe("createPlatformStreamingFetch off Tauri", () => {
  it("delegates to the platform fetch, whose body already streams", async () => {
    mockIsTauri.mockReturnValue(false)
    const platformFetch = jest.fn().mockResolvedValue(new Response("hi", { status: 200 }))
    globalThis.fetch = platformFetch as unknown as typeof globalThis.fetch

    const response = await createPlatformStreamingFetch()("https://api.example.com/events")

    expect(await response.text()).toBe("hi")
    expect(mockInvoke).not.toHaveBeenCalled()
    expect(platformFetch).toHaveBeenCalled()
  })

  it("drops the native-only options rather than passing them to fetch", async () => {
    mockIsTauri.mockReturnValue(false)
    const platformFetch = jest.fn().mockResolvedValue(new Response("hi"))
    globalThis.fetch = platformFetch as unknown as typeof globalThis.fetch

    await createPlatformStreamingFetch()("https://api.example.com/events", {
      readTimeout: 1_000,
      blockPrivateHosts: true,
      method: "POST",
      body: "x",
    })

    const [, init] = platformFetch.mock.calls[0] as [unknown, RequestInit]
    expect(init).not.toHaveProperty("readTimeout")
    expect(init).not.toHaveProperty("blockPrivateHosts")
    expect(init.method).toBe("POST")
  })

  it("honours the injected shell probe instead of the ambient one", async () => {
    mockIsTauri.mockReturnValue(true)
    const platformFetch = jest.fn().mockResolvedValue(new Response("browser"))
    globalThis.fetch = platformFetch as unknown as typeof globalThis.fetch

    const response = await createPlatformStreamingFetch({ isTauri: () => false })(
      "https://api.example.com/events"
    )

    expect(await response.text()).toBe("browser")
  })
})
