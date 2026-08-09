/**
 * @jest-environment jsdom
 */

const invokeMock = jest.fn()
const listenMock = jest.fn()

jest.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }))
jest.mock("@tauri-apps/api/event", () => ({ listen: (...a: unknown[]) => listenMock(...a) }))

import type { OllamaPullProgress } from "@cognia/provider-types/ollama"
import { pullOllamaModelStreaming } from "./ollama-pull"
import {
  resetProviderCoreRuntimeAdaptersForTesting,
  setProviderCoreRuntimeAdapters,
} from "./runtime-adapters"

const fetchMock = jest.fn()
const originalFetch = global.fetch

beforeEach(() => {
  invokeMock.mockReset()
  listenMock.mockReset()
  fetchMock.mockReset()
  global.fetch = fetchMock as unknown as typeof fetch
  resetProviderCoreRuntimeAdaptersForTesting()
})

afterEach(() => {
  resetProviderCoreRuntimeAdaptersForTesting()
})

afterAll(() => {
  global.fetch = originalFetch
})

/** A Response whose body streams `chunks` in order, one per read(). */
function streamResponse(chunks: string[]): Response {
  const encoded = chunks.map((c) => new TextEncoder().encode(c))
  let i = 0
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () =>
          i < encoded.length
            ? { done: false, value: encoded[i++] }
            : { done: true, value: undefined },
      }),
    },
  } as unknown as Response
}

describe("pullOllamaModelStreaming — Tauri host", () => {
  beforeEach(() => {
    setProviderCoreRuntimeAdapters({ isTauri: () => true })
  })

  it("invokes the streaming Rust command, never the buffered proxy", async () => {
    listenMock.mockResolvedValue(jest.fn())
    invokeMock.mockResolvedValue(true)

    const result = await pullOllamaModelStreaming({
      baseUrl: "http://localhost:11434/v1/",
      modelName: "qwen2.5:3b",
    })

    expect(result.success).toBe(true)
    const [command, payload] = invokeMock.mock.calls[0]
    // `/api/pull` is NDJSON; proxy_http_request buffers the whole body and
    // would deliver every progress line after the download already finished.
    expect(command).toBe("ollama_pull_model_stream")
    // Tauri v2 camel-cases Rust's snake_case params — these keys must match
    // `base_url` / `model_name` / `pull_id` exactly or the invoke rejects.
    expect(payload).toMatchObject({
      baseUrl: "http://localhost:11434",
      modelName: "qwen2.5:3b",
      pullId: expect.any(String),
    })
    // The browser stream path must not also fire.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("passes API-key auth and validated custom headers to the Rust stream command", async () => {
    invokeMock.mockResolvedValue(true)

    await pullOllamaModelStreaming({
      baseUrl: "http://x",
      modelName: "m",
      apiKey: " secret ",
      customHeaders: { "X-Tenant": "local" },
    })

    expect(invokeMock).toHaveBeenCalledWith(
      "ollama_pull_model_stream",
      expect.objectContaining({
        apiKey: "secret",
        customHeaders: { "X-Tenant": "local" },
      })
    )
  })

  it("only registers a listener when a progress callback was supplied", async () => {
    invokeMock.mockResolvedValue(true)
    await pullOllamaModelStreaming({ baseUrl: "http://x", modelName: "m" })
    expect(listenMock).not.toHaveBeenCalled()
  })

  /**
   * Two concurrent pulls share one event name. Without a per-call id each would
   * receive the other's progress, and one's `unsubscribe` would appear to
   * silence both.
   */
  it("delivers only events carrying its own pull id", async () => {
    let handler:
      ((e: { payload: Partial<OllamaPullProgress> & { pullId?: string } }) => void) | null = null
    listenMock.mockImplementation(async (_evt: string, h: typeof handler) => {
      handler = h
      return jest.fn()
    })
    invokeMock.mockResolvedValue(true)
    const onProgress = jest.fn()

    await pullOllamaModelStreaming({ baseUrl: "http://x", modelName: "m", onProgress })
    const { pullId } = invokeMock.mock.calls[0][1]

    handler!({ payload: { pullId: "another-pull", status: "downloading" } })
    expect(onProgress).not.toHaveBeenCalled()

    handler!({ payload: { pullId, status: "downloading", completed: 5 } })
    expect(onProgress).toHaveBeenCalledTimes(1)
    // `model` is stamped on locally — the server does not echo it back.
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ model: "m", status: "downloading", completed: 5 })
    )
  })

  it("gives each concurrent pull a distinct id", async () => {
    listenMock.mockResolvedValue(jest.fn())
    invokeMock.mockResolvedValue(true)

    await pullOllamaModelStreaming({ baseUrl: "http://x", modelName: "m", onProgress: jest.fn() })
    await pullOllamaModelStreaming({ baseUrl: "http://x", modelName: "m", onProgress: jest.fn() })

    expect(invokeMock.mock.calls[0][1].pullId).not.toBe(invokeMock.mock.calls[1][1].pullId)
  })

  it("detaches the listener when the command throws, then rethrows", async () => {
    const unlisten = jest.fn()
    listenMock.mockResolvedValue(unlisten)
    invokeMock.mockRejectedValue(new Error("ollama pull failed: model not found"))

    await expect(
      pullOllamaModelStreaming({ baseUrl: "http://x", modelName: "nope", onProgress: jest.fn() })
    ).rejects.toThrow("model not found")
    expect(unlisten).toHaveBeenCalled()
  })

  it("detaches the listener when the caller aborts", async () => {
    const unlisten = jest.fn()
    listenMock.mockResolvedValue(unlisten)
    const controller = new AbortController()
    invokeMock.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(true), 0))
    )

    const pending = pullOllamaModelStreaming({
      baseUrl: "http://x",
      modelName: "m",
      onProgress: jest.fn(),
      signal: controller.signal,
    })
    controller.abort()
    await pending

    // Aborting stops REPORTING. It does not stop the download — Ollama's server
    // cannot cancel a pull, so this listener detach is the whole of "cancel".
    expect(unlisten).toHaveBeenCalled()
  })

  it("returns an unsubscribe that detaches the listener", async () => {
    const unlisten = jest.fn()
    listenMock.mockResolvedValue(unlisten)
    invokeMock.mockResolvedValue(true)

    const { unsubscribe } = await pullOllamaModelStreaming({
      baseUrl: "http://x",
      modelName: "m",
      onProgress: jest.fn(),
    })
    expect(unlisten).not.toHaveBeenCalled()
    unsubscribe()
    expect(unlisten).toHaveBeenCalled()
  })

  /**
   * Pins the module's central honesty contract, which is otherwise only prose.
   *
   * Ollama's server CANNOT cancel a pull — aborting the connection leaves the
   * transfer running to completion (ollama#13142). So `unsubscribe` detaches a
   * listener and nothing more. This asserts the NEGATIVE SPACE: no second
   * command is issued. It exists to fail loudly the day someone "helpfully"
   * adds an `ollama_cancel_pull` invoke here — a command that would either not
   * exist (the bug this whole change removes) or would lie to the user about
   * having stopped the download.
   */
  it("issues no cancel command — unsubscribing cannot stop the server-side download", async () => {
    listenMock.mockResolvedValue(jest.fn())
    invokeMock.mockResolvedValue(true)

    const { unsubscribe } = await pullOllamaModelStreaming({
      baseUrl: "http://x",
      modelName: "m",
      onProgress: jest.fn(),
    })
    expect(invokeMock).toHaveBeenCalledTimes(1)

    unsubscribe()

    // Still exactly the one pull command. No cancel was sent, because none can
    // work.
    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock.mock.calls.map(([name]) => name)).toEqual(["ollama_pull_model_stream"])
  })

  it("removes its abort listener so a shared long-lived signal does not accumulate closures", async () => {
    listenMock.mockResolvedValue(jest.fn())
    invokeMock.mockResolvedValue(true)
    const controller = new AbortController()
    const removeSpy = jest.spyOn(controller.signal, "removeEventListener")

    await pullOllamaModelStreaming({
      baseUrl: "http://x",
      modelName: "m",
      onProgress: jest.fn(),
      signal: controller.signal,
    })

    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function))
  })
})

describe("pullOllamaModelStreaming — browser host", () => {
  beforeEach(() => {
    setProviderCoreRuntimeAdapters({ isTauri: () => false })
  })

  it("streams NDJSON from /api/pull and stamps the model onto each line", async () => {
    fetchMock.mockResolvedValue(
      streamResponse([
        '{"status":"pulling manifest"}\n{"status":"downloading","completed":1,"total":10}\n',
      ])
    )
    const onProgress = jest.fn()

    const result = await pullOllamaModelStreaming({
      baseUrl: "http://ollama.local/",
      modelName: "m",
      onProgress,
    })

    expect(result.success).toBe(true)
    expect(fetchMock.mock.calls[0][0]).toBe("http://ollama.local/api/pull")
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ name: "m", stream: true })
    expect(onProgress).toHaveBeenNthCalledWith(1, { status: "pulling manifest", model: "m" })
    expect(onProgress).toHaveBeenNthCalledWith(2, {
      status: "downloading",
      completed: 1,
      total: 10,
      model: "m",
    })
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("sends API-key auth and custom headers on browser pulls", async () => {
    fetchMock.mockResolvedValue(streamResponse([]))

    await pullOllamaModelStreaming({
      baseUrl: "http://x",
      modelName: "m",
      apiKey: "secret",
      customHeaders: { "X-Tenant": "local" },
    })

    expect(fetchMock).toHaveBeenCalledWith(
      "http://x/api/pull",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
          "X-Tenant": "local",
        }),
      })
    )
  })

  it("rejects custom auth overrides before selecting a host transport", async () => {
    await expect(
      pullOllamaModelStreaming({
        baseUrl: "http://x",
        modelName: "m",
        customHeaders: { authorization: "Bearer override" },
      })
    ).rejects.toThrow("authorization: auth-header")
    expect(fetchMock).not.toHaveBeenCalled()
    expect(invokeMock).not.toHaveBeenCalled()
  })

  /**
   * Chunk boundaries land wherever the network puts them, so a JSON object
   * routinely spans two reads. Parsing per-chunk would drop it.
   */
  it("reassembles a line split across chunk boundaries", async () => {
    fetchMock.mockResolvedValue(streamResponse(['{"status":"down', 'loading","completed":7}\n']))
    const onProgress = jest.fn()

    await pullOllamaModelStreaming({ baseUrl: "http://x", modelName: "m", onProgress })

    expect(onProgress).toHaveBeenCalledTimes(1)
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ status: "downloading", completed: 7 })
    )
  })

  it("skips malformed lines without aborting a running download", async () => {
    fetchMock.mockResolvedValue(streamResponse(["not-json\n", '{"status":"ok"}\n', "\n"]))
    const onProgress = jest.fn()

    const result = await pullOllamaModelStreaming({
      baseUrl: "http://x",
      modelName: "m",
      onProgress,
    })

    expect(result.success).toBe(true)
    expect(onProgress).toHaveBeenCalledTimes(1)
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ status: "ok" }))
  })

  it("throws with the status code on a non-ok response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 } as unknown as Response)
    await expect(
      pullOllamaModelStreaming({ baseUrl: "http://x", modelName: "nope" })
    ).rejects.toThrow("Failed to pull model: 404")
  })

  it("throws when the response carries no stream body", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: null } as unknown as Response)
    await expect(pullOllamaModelStreaming({ baseUrl: "http://x", modelName: "m" })).rejects.toThrow(
      "No response body"
    )
  })

  it("forwards the abort signal to fetch", async () => {
    fetchMock.mockResolvedValue(streamResponse(['{"status":"ok"}\n']))
    const controller = new AbortController()

    await pullOllamaModelStreaming({
      baseUrl: "http://x",
      modelName: "m",
      signal: controller.signal,
    })

    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal)
  })

  it("normalizes a baseUrl carrying a /v1 suffix so /api paths append cleanly", async () => {
    fetchMock.mockResolvedValue(streamResponse([]))
    await pullOllamaModelStreaming({ baseUrl: "http://ollama.local/v1", modelName: "m" })
    expect(fetchMock.mock.calls[0][0]).toBe("http://ollama.local/api/pull")
  })
})
