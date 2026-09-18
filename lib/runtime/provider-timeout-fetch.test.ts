import { ProviderTimeoutError, withProviderTimeouts } from "@/lib/runtime/provider-timeout-fetch"

function streamResponse(chunks: Array<Uint8Array | "hang" | "close">): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        if (chunk === "hang") return // never enqueue, never close
        if (chunk === "close") {
          controller.close()
          return
        }
        controller.enqueue(chunk)
        // Yield so the wrapping reader's pull loop actually runs per chunk.
        await new Promise((r) => setTimeout(r, 1))
      }
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { "x-test": "1" } })
}

const fetchReturning = (response: Response | Promise<Response>): typeof fetch =>
  (() => Promise.resolve(response)) as typeof fetch

const hangingFetch = (() => new Promise<Response>(() => undefined)) as typeof fetch

async function drain(response: Response): Promise<string> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let out = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return out
    out += decoder.decode(value)
  }
}

describe("withProviderTimeouts", () => {
  it("passes a normal streaming response through untouched", async () => {
    const wrapped = withProviderTimeouts(
      fetchReturning(
        streamResponse([new TextEncoder().encode("he"), new TextEncoder().encode("llo"), "close"])
      ),
      { headersMs: 200, chunkMs: 200 }
    )
    const res = await wrapped("https://api.test/v1", {})
    expect(res.status).toBe(200)
    expect(res.headers.get("x-test")).toBe("1")
    expect(await drain(res)).toBe("hello")
  })

  it("fails with kind=headers when response headers never arrive", async () => {
    const wrapped = withProviderTimeouts(hangingFetch, { headersMs: 30, chunkMs: false })
    await expect(wrapped("https://api.test/v1", {})).rejects.toMatchObject({
      name: "ProviderTimeoutError",
      kind: "headers",
      timeoutMs: 30,
    })
  })

  it("fails with kind=idle-chunk when the body stalls between chunks", async () => {
    const wrapped = withProviderTimeouts(
      fetchReturning(streamResponse([new TextEncoder().encode("first"), "hang"])),
      { headersMs: 200, chunkMs: 30 }
    )
    const res = await wrapped("https://api.test/v1", {})
    const reader = res.body!.getReader()
    const first = await reader.read()
    expect(first.done).toBe(false)
    await expect(reader.read()).rejects.toMatchObject({
      name: "ProviderTimeoutError",
      kind: "idle-chunk",
    } satisfies Partial<ProviderTimeoutError>)
  })

  it("respects headersMs:false — a hung request stays pending until caller aborts", async () => {
    const wrapped = withProviderTimeouts(hangingFetch, { headersMs: false, chunkMs: false })
    const ctrl = new AbortController()
    const pending = wrapped("https://api.test/v1", { signal: ctrl.signal })
    setTimeout(() => ctrl.abort(), 20)
    await expect(pending).rejects.toThrow()
  })

  it("respects chunkMs:false — a stalled body just stays open", async () => {
    const wrapped = withProviderTimeouts(
      fetchReturning(streamResponse([new TextEncoder().encode("x"), "hang"])),
      { headersMs: 100, chunkMs: false }
    )
    const res = await wrapped("https://api.test/v1", {})
    const reader = res.body!.getReader()
    await reader.read()
    const result = await Promise.race([
      reader.read().then(() => "settled"),
      new Promise<string>((r) => setTimeout(() => r("pending"), 60)),
    ])
    expect(result).toBe("pending")
    await reader.cancel()
  })

  it("forwards a caller abort during the headers wait", async () => {
    const wrapped = withProviderTimeouts(hangingFetch, { headersMs: 10_000 })
    const ctrl = new AbortController()
    const pending = wrapped("https://api.test/v1", { signal: ctrl.signal })
    setTimeout(() => ctrl.abort(new Error("user abort")), 10)
    await expect(pending).rejects.toThrow("user abort")
  })

  it("handles a null-body response without wrapping", async () => {
    const wrapped = withProviderTimeouts(fetchReturning(new Response(null, { status: 204 })), {
      headersMs: 100,
      chunkMs: 30,
    })
    const res = await wrapped("https://api.test/v1", {})
    expect(res.status).toBe(204)
    expect(res.body).toBeNull()
  })

  it("surfaces a fetch rejection as-is", async () => {
    const boom = new TypeError("socket hangup")
    const wrapped = withProviderTimeouts((() => Promise.reject(boom)) as typeof fetch, {
      headersMs: 200,
    })
    await expect(wrapped("https://api.test/v1", {})).rejects.toBe(boom)
  })
})
