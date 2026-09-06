import { classifyHealthz, probeRelay, relayHealthUrl, relayProtocolMatches } from "./relay-probe"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("relayHealthUrl", () => {
  it("turns the wss signaling endpoint into the https health endpoint at the root", () => {
    expect(relayHealthUrl("wss://signaling.cognia.cn/signaling")).toBe(
      "https://signaling.cognia.cn/healthz"
    )
    expect(relayHealthUrl("wss://signaling.cognia.cn/v2/signaling?rid=x#y")).toBe(
      "https://signaling.cognia.cn/healthz"
    )
    expect(relayHealthUrl("ws://127.0.0.1:7892/signaling")).toBe("http://127.0.0.1:7892/healthz")
    expect(relayHealthUrl("  https://relay.example/signaling ")).toBe(
      "https://relay.example/healthz"
    )
  })

  it("refuses what is not a URL or not a web scheme", () => {
    expect(relayHealthUrl("")).toBeNull()
    expect(relayHealthUrl("signaling.cognia.cn")).toBeNull()
    expect(relayHealthUrl("ftp://relay.example/signaling")).toBeNull()
  })
})

describe("classifyHealthz", () => {
  it("reads a data-lane deployment as ready", () => {
    const verdict = classifyHealthz({
      ok: true,
      backend: "worker",
      version: "0.1.0",
      capabilities: { protocol: 2, lanes: ["signal", "data"], relayDataLane: true },
    })
    expect(verdict.state).toBe("ready")
    expect(verdict.backend).toBe("worker")
    expect(verdict.capabilities?.lanes).toEqual(["signal", "data"])
    expect(relayProtocolMatches(verdict.capabilities)).toBe(true)
  })

  it("reads a pre-lane deployment as legacy, whether it says nothing or only signals", () => {
    expect(classifyHealthz({ ok: true, version: "0.1.0", backend: "worker" }).state).toBe("legacy")
    expect(
      classifyHealthz({
        ok: true,
        version: "0.1.0",
        capabilities: { protocol: 1, lanes: ["signal"], relayDataLane: false },
      }).state
    ).toBe("legacy")
  })

  it("reads anything else as not a relay", () => {
    expect(classifyHealthz(null).state).toBe("not-a-relay")
    expect(classifyHealthz("<html>").state).toBe("not-a-relay")
    expect(classifyHealthz({ ok: false, version: "1" }).state).toBe("not-a-relay")
    expect(classifyHealthz({ status: "live" }).state).toBe("not-a-relay")
  })
})

describe("probeRelay", () => {
  it("fetches the health URL with no credentials and reports latency", async () => {
    const fetchImpl = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://signaling.cognia.cn/healthz")
      expect(init?.credentials).toBe("omit")
      return jsonResponse({
        ok: true,
        backend: "axum",
        version: "0.1.0",
        capabilities: { protocol: 2, lanes: ["signal", "data"], relayDataLane: true },
      })
    })
    let tick = 100
    const result = await probeRelay("wss://signaling.cognia.cn/signaling", {
      fetchImpl,
      now: () => (tick += 40),
    })
    expect(result.state).toBe("ready")
    expect(result.healthUrl).toBe("https://signaling.cognia.cn/healthz")
    expect(result.latencyMs).toBe(40)
    expect(result.backend).toBe("axum")
  })

  it("reports an invalid URL without fetching", async () => {
    const fetchImpl = jest.fn()
    const result = await probeRelay("nope", { fetchImpl })
    expect(result.state).toBe("invalid-url")
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("reports a network failure as unreachable and a timeout by name", async () => {
    const failing = jest.fn(async () => {
      throw new TypeError("Failed to fetch")
    })
    expect(
      await probeRelay("wss://r.example/signaling", { fetchImpl: failing, opaqueRetry: false })
    ).toMatchObject({
      state: "unreachable",
      error: "Failed to fetch",
    })
    const hanging = jest.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted")
            error.name = "AbortError"
            reject(error)
          })
        })
    )
    const result = await probeRelay("wss://r.example/signaling", {
      fetchImpl: hanging,
      timeoutMs: 5,
      opaqueRetry: true,
      opaqueFetchImpl: jest.fn(async () => new Response("", { status: 200 })),
    })
    expect(result).toMatchObject({ state: "unreachable", error: "timeout" })
  })

  it("in a browser, tells a relay this origin may not read from one that is not there", async () => {
    const failing = jest.fn(async () => {
      throw new TypeError("Failed to fetch")
    })
    const opaqueOk = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://signaling.cognia.cn/healthz")
      expect(init?.mode).toBe("no-cors")
      return new Response("", { status: 200 })
    })
    expect(
      await probeRelay("wss://signaling.cognia.cn/signaling", {
        fetchImpl: failing,
        opaqueRetry: true,
        opaqueFetchImpl: opaqueOk,
      })
    ).toMatchObject({ state: "cors-blocked", error: "Failed to fetch" })
    const opaqueDead = jest.fn(async () => {
      throw new TypeError("Failed to fetch")
    })
    expect(
      await probeRelay("wss://signaling.cognia.cn/signaling", {
        fetchImpl: failing,
        opaqueRetry: true,
        opaqueFetchImpl: opaqueDead,
      })
    ).toMatchObject({ state: "unreachable" })
  })

  it("reports a non-JSON or non-2xx answer as not a relay", async () => {
    const html = jest.fn(async () => new Response("<html>", { status: 200 }))
    expect((await probeRelay("wss://r.example/signaling", { fetchImpl: html })).state).toBe(
      "not-a-relay"
    )
    const notFound = jest.fn(async () => jsonResponse({ error: "x" }, 404))
    expect(await probeRelay("wss://r.example/signaling", { fetchImpl: notFound })).toMatchObject({
      state: "not-a-relay",
      error: "HTTP 404",
    })
  })
})
