const readWithVendorMock = jest.fn()
jest.mock("./vendor-readers", () => ({
  readWithVendor: (...a: unknown[]) => readWithVendorMock(...a),
}))

import type { WebReaderId } from "@cognia/agent-config-types"
import { OperationAdmission } from "@cognia/web-search/operation-policy"
import { FetchCache } from "@/lib/web/fetch-cache"
import { planReaders, readWithPolicy, type ReaderHostDeps } from "./configured-reader"
import type { ReaderPolicy } from "./reader-settings"

const LONG_TEXT = "Readable paragraph about the topic. ".repeat(20)
const ARTICLE = `<html><head><title>Article</title></head><body><article><p>${LONG_TEXT}</p></article></body></html>`

function res(
  body: string,
  opts: { status?: number; contentType?: string; contentLength?: number } = {}
): Response {
  const headers = new Map<string, string>([["content-type", opts.contentType ?? "text/html"]])
  if (opts.contentLength !== undefined) headers.set("content-length", String(opts.contentLength))
  const status = opts.status ?? 200
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    text: async () => body,
  } as unknown as Response
}

function policy(overrides: Partial<ReaderPolicy> & { enable?: WebReaderId[] } = {}): ReaderPolicy {
  const enabled = new Set<WebReaderId>(overrides.enable ?? ["direct", "platform"])
  return {
    defaultReader: "auto",
    enabled,
    externalOrder: (["jina", "tavily", "exa", "deepseek", "tinyfish"] as WebReaderId[]).filter(
      (id) => enabled.has(id)
    ),
    externalFallback: false,
    distillation: "off",
    timeoutMs: 60_000,
    maxAttempts: 3,
    revision: "test",
    ...overrides,
  }
}

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>

function host(route: Route, overrides: Partial<ReaderHostDeps> = {}) {
  const fetchImpl = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    route(String(input), init)
  )
  const deps: ReaderHostDeps = {
    policy: policy(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    admission: new OperationAdmission(),
    ...overrides,
  }
  return { deps, fetchImpl }
}

const jinaUrl = (url: string) => `https://r.jina.ai/${url}`

beforeEach(() => readWithVendorMock.mockReset())

describe("direct reading", () => {
  it("extracts readable text and reports the origin status", async () => {
    const { deps } = host(() => res(ARTICLE))
    const r = (await readWithPolicy({ url: "https://site.example/a" }, deps)) as Record<
      string,
      unknown
    >
    expect(r).toMatchObject({
      ok: true,
      status: 200,
      statusSource: "origin",
      reader: "direct",
      title: "Article",
      extraction: "html",
      truncated: false,
      readWindow: { offset: 0, cap: 40 * 1024, unit: "characters" },
    })
    expect(String(r.text)).toContain("Readable paragraph")
  })

  it("rejects URLs with embedded credentials", async () => {
    const { deps, fetchImpl } = host(() => res(ARTICLE))
    expect(await readWithPolicy({ url: "https://u:p@site.example/" }, deps)).toMatchObject({
      ok: false,
      code: "invalid-arguments",
      reason: "credentialed-url",
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("blocks private targets unless the host allows them, and never sends them to a remote reader", async () => {
    const { deps, fetchImpl } = host(() => res(ARTICLE), {
      policy: policy({ enable: ["direct", "jina"], externalFallback: true }),
    })
    expect(await readWithPolicy({ url: "http://127.0.0.1:8080/" }, deps)).toMatchObject({
      code: "blocked",
    })
    const allowed = { ...deps, allowPrivateHosts: true }
    expect(
      await readWithPolicy({ url: "http://127.0.0.1:8080/", reader: "jina" }, allowed)
    ).toMatchObject({ code: "blocked", reason: "private-target" })
    fetchImpl.mockImplementationOnce(async () => {
      throw new Error("connection refused")
    })
    await readWithPolicy({ url: "http://127.0.0.1:8080/" }, allowed)
    expect(fetchImpl.mock.calls.map((c) => String(c[0]))).toEqual(["http://127.0.0.1:8080/"])
  })
})

describe("direct-only requests (AC14)", () => {
  const external = policy({ enable: ["direct", "jina", "tavily"], externalFallback: true })

  it.each([
    [{ format: "raw" as const }],
    [{ method: "POST", body: "x=1" }],
    [{ headers: { Authorization: "Bearer t" } }],
  ])("only reaches the direct transport for %j", async (extra) => {
    const { deps, fetchImpl } = host(() => res("nope", { status: 503 }), {
      policy: external,
      credentialFor: () => "k",
    })
    await readWithPolicy({ url: "https://site.example/a", ...extra }, deps)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://site.example/a")
    expect(readWithVendorMock).not.toHaveBeenCalled()
  })

  it("refuses to pin a remote reader for a raw request", async () => {
    const { deps } = host(() => res(ARTICLE), { policy: external })
    expect(
      await readWithPolicy({ url: "https://site.example/a", format: "raw", reader: "jina" }, deps)
    ).toMatchObject({ code: "invalid-arguments", reason: "reader-not-allowed" })
  })

  it("rejects raw requests while required distillation is on, before any I/O", async () => {
    const { deps, fetchImpl } = host(() => res(ARTICLE), {
      policy: policy({ distillation: "required" }),
    })
    expect(
      await readWithPolicy({ url: "https://site.example/a", format: "raw" }, deps)
    ).toMatchObject({ code: "invalid-arguments", reason: "conflicting-mode" })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("returns a raw body verbatim with its HTTP status", async () => {
    const { deps } = host(() => res('{"a":1}', { status: 404, contentType: "application/json" }))
    expect(
      await readWithPolicy({ url: "https://site.example/a", format: "raw" }, deps)
    ).toMatchObject({ ok: false, status: 404, body: '{"a":1}', statusSource: "origin" })
  })
})

describe("fallback routing (AC09)", () => {
  const withJina = policy({ enable: ["direct", "jina"], externalFallback: true })

  it("falls back to an enabled external reader after a network rejection", async () => {
    const { deps } = host(
      (url) => {
        if (url.startsWith("https://r.jina.ai/"))
          return res(`Title: J\nMarkdown Content:\n${LONG_TEXT}`, { contentType: "text/plain" })
        throw new Error("ECONNRESET")
      },
      { policy: withJina }
    )
    const r = await readWithPolicy({ url: "https://site.example/a" }, deps)
    expect(r).toMatchObject({
      ok: true,
      reader: "jina",
      source: "jina",
      statusSource: "reader-service",
      title: "J",
      attemptedReaders: ["direct", "jina"],
    })
    expect(r).not.toHaveProperty("originStatus")
  })

  it("keeps the origin's anti-bot status as metadata when a reader recovers the page", async () => {
    const { deps } = host(
      (url) =>
        url.startsWith("https://r.jina.ai/")
          ? res(`Markdown Content:\n${LONG_TEXT}`, { contentType: "text/plain" })
          : res("<html>Just a moment... cf-chl</html>", { status: 403 }),
      { policy: withJina }
    )
    expect(await readWithPolicy({ url: "https://site.example/a" }, deps)).toMatchObject({
      ok: true,
      status: 200,
      statusSource: "reader-service",
      originStatus: 403,
    })
  })

  it.each([
    ["404", res("missing", { status: 404 })],
    ["plain 403", res("forbidden", { status: 403 })],
    ["401", res("auth", { status: 401 })],
    ["paywall 403", res("Subscribe to continue reading", { status: 403 })],
  ])("treats %s as terminal and never calls an external reader", async (_label, response) => {
    const { deps, fetchImpl } = host(() => response, { policy: withJina })
    const r = await readWithPolicy({ url: "https://site.example/a" }, deps)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(r).toMatchObject({ statusSource: "origin", reader: "direct" })
  })

  it("does not use external readers when external fallback is off", async () => {
    const { deps, fetchImpl } = host(
      () => {
        throw new Error("ECONNRESET")
      },
      { policy: policy({ enable: ["direct", "jina"], externalFallback: false }) }
    )
    expect(await readWithPolicy({ url: "https://site.example/a" }, deps)).toMatchObject({
      ok: false,
      reason: "all-readers-failed",
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("keeps thin local text when the external reader has nothing better", async () => {
    const { deps } = host(
      (url) =>
        url.startsWith("https://r.jina.ai/")
          ? res("", { status: 500, contentType: "text/plain" })
          : res("<html><body><p>tiny</p></body></html>"),
      { policy: withJina }
    )
    expect(await readWithPolicy({ url: "https://site.example/a" }, deps)).toMatchObject({
      ok: true,
      reader: "direct",
      text: "tiny",
    })
  })

  it("converts a PDF through an external reader and otherwise explains the binary", async () => {
    const pdf = () => res("%PDF", { contentType: "application/pdf" })
    const { deps } = host(
      (url) =>
        url.startsWith("https://r.jina.ai/")
          ? res(`Markdown Content:\n${LONG_TEXT}`, { contentType: "text/plain" })
          : pdf(),
      { policy: withJina }
    )
    expect(await readWithPolicy({ url: "https://site.example/a.pdf" }, deps)).toMatchObject({
      reader: "jina",
    })
    const plain = host(pdf)
    expect(await readWithPolicy({ url: "https://site.example/a.pdf" }, plain.deps)).toMatchObject({
      binary: true,
      note: expect.stringContaining("PDF"),
    })
  })

  it("respects the attempt budget", async () => {
    const { deps, fetchImpl } = host(
      () => {
        throw new Error("ECONNRESET")
      },
      { policy: { ...withJina, maxAttempts: 1 } }
    )
    await readWithPolicy({ url: "https://site.example/a" }, deps)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe("reader selection (AC13)", () => {
  it("pins a vendor reader strictly, without a direct pre-fetch", async () => {
    readWithVendorMock.mockResolvedValueOnce({
      kind: "content",
      reader: "tavily",
      source: "tavily",
      text: LONG_TEXT,
      contentType: "text/markdown",
      status: 200,
      statusSource: "reader-service",
      extraction: "markdown",
    })
    const { deps, fetchImpl } = host(() => res(ARTICLE), {
      policy: policy({ enable: ["direct", "tavily"] }),
      credentialFor: (id) => (id === "tavily" ? "tvly-key" : undefined),
    })
    expect(
      await readWithPolicy({ url: "https://site.example/a", reader: "tavily" }, deps)
    ).toMatchObject({
      reader: "tavily",
    })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(readWithVendorMock).toHaveBeenCalledWith(
      "tavily",
      "https://site.example/a",
      "tvly-key",
      expect.objectContaining({ signal: expect.any(Object) })
    )
  })

  it("refuses a pinned reader that is disabled or has no credential", async () => {
    const { deps } = host(() => res(ARTICLE), { policy: policy({ enable: ["direct", "tavily"] }) })
    expect(
      await readWithPolicy({ url: "https://site.example/a", reader: "tavily" }, deps)
    ).toMatchObject({
      code: "unsupported-host",
      reason: "reader-unavailable",
    })
    expect(
      await readWithPolicy({ url: "https://site.example/a", reader: "exa" }, deps)
    ).toMatchObject({
      reason: "reader-unavailable",
    })
    expect(readWithVendorMock).not.toHaveBeenCalled()
  })

  it("does not fall back from a strict pin, but does with allowFallback", async () => {
    readWithVendorMock.mockResolvedValue({
      kind: "failure",
      reader: "tavily",
      failure: "vendor-quota",
      detail: "402",
    })
    const { deps, fetchImpl } = host(() => res(ARTICLE), {
      policy: policy({ enable: ["direct", "tavily"] }),
      credentialFor: () => "k",
    })
    expect(
      await readWithPolicy({ url: "https://site.example/a", reader: "tavily" }, deps)
    ).toMatchObject({
      ok: false,
    })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(
      await readWithPolicy(
        { url: "https://site.example/a", reader: "tavily", allowFallback: true },
        deps
      )
    ).toMatchObject({ ok: true, reader: "direct" })
  })

  it("never enables a vendor reader just because a credential exists", () => {
    const plan = planReaders(
      "https://site.example/a",
      {},
      { policy: policy({ externalFallback: true }), credentialFor: () => "k" }
    )
    expect(plan.plan).toEqual(["direct"])
  })

  it("routes X posts to FxTwitter only when that recipient is enabled", () => {
    expect(planReaders("https://x.com/a/status/1", {}, { policy: policy() }).plan).toEqual([
      "direct",
    ])
    expect(
      planReaders(
        "https://x.com/a/status/1",
        {},
        { policy: policy({ enable: ["direct", "fxtwitter"] }) }
      ).plan
    ).toEqual(["fxtwitter", "direct"])
  })

  it("skips readers the host cannot reach", () => {
    const plan = planReaders(
      "https://site.example/a",
      {},
      {
        policy: policy({ enable: ["direct", "jina"], externalFallback: true }),
        hostReachable: { jina: false },
      }
    )
    expect(plan.plan).toEqual(["direct"])
  })
})

describe("distillation (AC08 / Q2)", () => {
  it("fails closed when required distillation has no model", async () => {
    const { deps } = host(() => res(ARTICLE), { policy: policy({ distillation: "required" }) })
    expect(await readWithPolicy({ url: "https://site.example/a" }, deps)).toMatchObject({
      ok: false,
      code: "unsupported-host",
      reason: "distillation-unavailable",
    })
  })

  it("fails closed when the required extraction fails", async () => {
    const { deps } = host(() => res(ARTICLE), {
      policy: policy({ distillation: "required" }),
      summarize: async () => {
        throw new Error("model down")
      },
    })
    expect(await readWithPolicy({ url: "https://site.example/a" }, deps)).toMatchObject({
      reason: "distillation-failed",
    })
  })

  it("distills JSON too under required mode, never returning the raw body", async () => {
    const summarize = jest.fn(async () => "summary")
    const { deps } = host(() => res('{"secret":1}', { contentType: "application/json" }), {
      policy: policy({ distillation: "required" }),
      summarize,
    })
    const r = await readWithPolicy({ url: "https://site.example/a.json" }, deps)
    expect(r).toMatchObject({ text: "summary", distilled: true })
    expect(r).not.toHaveProperty("body")
  })

  it("withholds error-page bodies under required mode", async () => {
    const { deps } = host(() => res("secret error page", { status: 404 }), {
      policy: policy({ distillation: "required" }),
      summarize: async () => "x",
    })
    const r = await readWithPolicy({ url: "https://site.example/a" }, deps)
    expect(r).toMatchObject({ status: 404, distilled: false })
    expect(r).not.toHaveProperty("body")
  })

  it("marks a best-effort failure as not distilled and keeps the text", async () => {
    const { deps } = host(() => res(ARTICLE), {
      policy: policy({ distillation: "best-effort" }),
      summarize: async () => "",
    })
    const r = await readWithPolicy({ url: "https://site.example/a" }, deps)
    expect(r).toMatchObject({
      distilled: false,
      warnings: [expect.stringContaining("distillation-failed")],
    })
    expect(String((r as { text?: string }).text)).toContain("Readable paragraph")
  })

  it("narrows to the prompt when a model exists", async () => {
    const summarize = jest.fn(async () => "focused")
    const { deps } = host(() => res(ARTICLE), { summarize })
    expect(
      await readWithPolicy({ url: "https://site.example/a", prompt: "who?" }, deps)
    ).toMatchObject({
      text: "focused",
      distilled: true,
    })
    expect(summarize).toHaveBeenCalledWith(expect.any(String), "who?", expect.any(Object))
  })
})

describe("cache (AC02a / AC15)", () => {
  it("pages from the cached representation without another fetch", async () => {
    const cache = new FetchCache()
    const { deps, fetchImpl } = host(() => res(ARTICLE), { cache, scope: "a" })
    const first = (await readWithPolicy(
      { url: "https://site.example/a", maxBytes: 100 },
      deps
    )) as {
      nextOffset: number
    }
    const second = await readWithPolicy(
      { url: "https://site.example/a", maxBytes: 100, offset: first.nextOffset },
      deps
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(second).toMatchObject({ cacheHit: true, readWindow: { offset: 100, cap: 100 } })
  })

  it("never serves another scope's entry", async () => {
    const cache = new FetchCache()
    const a = host(() => res(ARTICLE), { cache, scope: "a" })
    await readWithPolicy({ url: "https://site.example/a" }, a.deps)
    const b = host(() => res(ARTICLE), { cache, scope: "b" })
    await readWithPolicy({ url: "https://site.example/a" }, b.deps)
    expect(b.fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("re-evaluates the target guard before reading the cache", async () => {
    const cache = new FetchCache()
    const allowed = host(() => res(ARTICLE), { cache, allowPrivateHosts: true })
    await readWithPolicy({ url: "http://10.0.0.5/" }, allowed.deps)
    const denied = host(() => res(ARTICLE), { cache, allowPrivateHosts: false })
    expect(await readWithPolicy({ url: "http://10.0.0.5/" }, denied.deps)).toMatchObject({
      code: "blocked",
    })
  })

  it("never caches private targets or header-bearing requests", async () => {
    const cache = new FetchCache()
    const { deps } = host(() => res(ARTICLE), { cache, allowPrivateHosts: true })
    await readWithPolicy({ url: "http://10.0.0.5/" }, deps)
    await readWithPolicy({ url: "https://site.example/a", headers: { Cookie: "s=1" } }, deps)
    expect(cache.size).toBe(0)
  })

  it("does not serve a cached raw read once the distillation policy changes", async () => {
    const cache = new FetchCache()
    const open = host(() => res(ARTICLE), { cache })
    await readWithPolicy({ url: "https://site.example/a" }, open.deps)
    const strict = host(() => res(ARTICLE), {
      cache,
      policy: policy({ distillation: "required", revision: "strict" }),
    })
    expect(await readWithPolicy({ url: "https://site.example/a" }, strict.deps)).toMatchObject({
      reason: "distillation-unavailable",
    })
  })
})

describe("cancellation, limits and scope (AC10 / AC15)", () => {
  it("settles as cancelled and writes nothing after an abort", async () => {
    const cache = new FetchCache()
    const controller = new AbortController()
    const { deps, fetchImpl } = host(
      () => {
        controller.abort()
        throw new DOMException("Aborted", "AbortError")
      },
      {
        cache,
        signal: controller.signal,
        policy: policy({ enable: ["direct", "jina"], externalFallback: true }),
      }
    )
    expect(await readWithPolicy({ url: "https://site.example/a" }, deps)).toMatchObject({
      reason: "cancelled",
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(cache.size).toBe(0)
  })

  it("refuses an oversized body by declared length and by streamed bytes", async () => {
    const declared = host(() => res("x", { contentLength: 9_000_000 }))
    expect(await readWithPolicy({ url: "https://site.example/big" }, declared.deps)).toMatchObject({
      reason: "too-large",
    })
    const streamed = host(
      () =>
        ({
          ok: true,
          status: 200,
          headers: { get: () => "text/html" },
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(64))
              controller.enqueue(new Uint8Array(64))
              controller.close()
            },
          }),
        }) as unknown as Response,
      { byteCeiling: 100 }
    )
    expect(await readWithPolicy({ url: "https://site.example/big" }, streamed.deps)).toMatchObject({
      reason: "too-large",
    })
  })

  it("returns a retryable rate limit when admission is full", async () => {
    const admission = new OperationAdmission({ search: 1, read: 1 }, 0)
    await admission.acquire("default", "read")
    const { deps } = host(() => res(ARTICLE), { admission })
    expect(await readWithPolicy({ url: "https://site.example/a" }, deps)).toMatchObject({
      code: "rate-limited",
      reason: "admission-full",
    })
  })

  it("discards a read whose scope changed in flight", async () => {
    let scope = "a"
    const cache = new FetchCache()
    const { deps } = host(
      () => {
        scope = "b"
        return res(ARTICLE)
      },
      { cache, scope: "a", activeScope: () => scope }
    )
    expect(await readWithPolicy({ url: "https://site.example/a" }, deps)).toMatchObject({
      reason: "scope-changed",
    })
    expect(cache.size).toBe(0)
  })

  it("discloses a host that cannot recall an in-flight request", async () => {
    const { deps } = host(() => res(ARTICLE), { transportCancels: false })
    expect(await readWithPolicy({ url: "https://site.example/a" }, deps)).toMatchObject({
      warnings: [expect.stringContaining("transport-cancellation")],
    })
  })

  it("forwards the operation signal to the transport", async () => {
    const { deps, fetchImpl } = host(() => res(ARTICLE))
    await readWithPolicy({ url: "https://site.example/a" }, deps)
    expect(fetchImpl.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal)
  })
})

describe("jina URL shape", () => {
  it("prefixes the reader endpoint", () => {
    expect(jinaUrl("https://a.example")).toBe("https://r.jina.ai/https://a.example")
  })
})
