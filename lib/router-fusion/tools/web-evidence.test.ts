import {
  createWebEvidence,
  guardedRedirectFetch,
  MAX_EVIDENCE_REDIRECTS,
  webEvidenceAvailable,
  WEB_EVIDENCE_MAX_CHARS,
  type SsrfAuditEntry,
  type WebEvidenceDeps,
} from "./web-evidence"

function redirect(to: string, status = 302): Response {
  return new Response(null, { status, headers: { location: to } })
}

function page(text: string, status = 200): Response {
  return new Response(text, { status, headers: { "content-type": "text/plain" } })
}

describe("guardedRedirectFetch", () => {
  it("follows public redirects hop by hop and reports where it ended", async () => {
    const seen: Array<[string, RequestInit | undefined]> = []
    const base = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      seen.push([url, init])
      return url.endsWith("/start") ? redirect("/next") : page("done")
    })
    let final = ""
    const fetchImpl = guardedRedirectFetch(base, {
      audit: () => undefined,
      onFinalUrl: (url) => (final = url),
    })
    const response = await fetchImpl("https://example.com/start")
    expect(await response.text()).toBe("done")
    expect(seen.map(([url]) => url)).toEqual([
      "https://example.com/start",
      "https://example.com/next",
    ])
    expect(seen.every(([, init]) => init?.redirect === "manual")).toBe(true)
    expect(final).toBe("https://example.com/next")
  })

  it("[ACC:SAFE-01] refuses a redirect into the metadata service and records the hop", async () => {
    const audit: SsrfAuditEntry[] = []
    const base = jest.fn(async (input: RequestInfo | URL) =>
      String(input).includes("example.com")
        ? redirect("http://169.254.169.254/latest/meta-data/")
        : page("secret")
    )
    const fetchImpl = guardedRedirectFetch(base, { audit: (entry) => audit.push(entry) })
    await expect(fetchImpl("https://example.com/innocent")).rejects.toThrow()
    // The metadata address was never requested.
    expect(base).toHaveBeenCalledTimes(1)
    expect(audit).toEqual([{ host: "169.254.169.254", reason: "private-host", hop: 1 }])
  })

  it("refuses a redirect it cannot read, and a chain that never ends", async () => {
    const opaque: SsrfAuditEntry[] = []
    const browser = guardedRedirectFetch(
      async () => ({ type: "opaqueredirect", status: 0, headers: new Headers() }) as Response,
      { audit: (entry) => opaque.push(entry) }
    )
    await expect(browser("https://example.com/a")).rejects.toThrow("redirect-unreadable")
    expect(opaque[0]).toMatchObject({ reason: "redirect-unreadable", hop: 0 })

    const looping: SsrfAuditEntry[] = []
    const loop = guardedRedirectFetch(async (input) => redirect(`${String(input)}x`), {
      audit: (entry) => looping.push(entry),
    })
    await expect(loop("https://example.com/")).rejects.toThrow("too-many-redirects")
    expect(looping).toEqual([
      { host: "example.com", reason: "too-many-redirects", hop: MAX_EVIDENCE_REDIRECTS + 1 },
    ])
  })

  it("returns a redirect without a location as the answer it is", async () => {
    const fetchImpl = guardedRedirectFetch(async () => new Response(null, { status: 304 }), {
      audit: () => undefined,
    })
    await expect(fetchImpl("https://example.com/")).resolves.toMatchObject({ status: 304 })
  })
})

function deps(overrides: Partial<WebEvidenceDeps> = {}): WebEvidenceDeps {
  return {
    transport: async () => page("Tariff table: 4%"),
    webFetch: jest.fn(async (args, fetchDeps) => {
      const response = await fetchDeps!.fetchImpl!(args.url)
      return {
        ok: response.ok,
        status: response.status,
        text: await response.text(),
        title: "Tariffs",
        truncated: false,
      }
    }) as unknown as WebEvidenceDeps["webFetch"],
    ...overrides,
  }
}

describe("createWebEvidence", () => {
  it("reads a public page as evidence, with no private hosts, no distillation and no third-party reader", async () => {
    const d = deps()
    const result = await createWebEvidence(d).fetchPage(
      "https://example.com/t",
      new AbortController().signal
    )
    expect(result).toEqual({
      ok: true,
      finalUrl: "https://example.com/t",
      title: "Tariffs",
      content: "Tariff table: 4%",
      truncated: false,
    })
    expect(d.webFetch).toHaveBeenCalledWith(
      { url: "https://example.com/t", format: "text", maxBytes: WEB_EVIDENCE_MAX_CHARS },
      expect.objectContaining({
        allowPrivateHosts: false,
        alwaysDistill: false,
        jinaFallback: false,
      })
    )
    const passed = (d.webFetch as jest.Mock).mock.calls[0][1]
    expect(passed.summarize).toBeUndefined()
    expect(passed.cache).toBeUndefined()
  })

  it("[ACC:SAFE-01] refuses a loopback or metadata URL before any request, and says so", async () => {
    const transport = jest.fn()
    const evidence = createWebEvidence(deps({ transport }))
    for (const url of [
      "http://127.0.0.1:8080/admin",
      "http://169.254.169.254/",
      "http://[::1]/",
      "file:///etc/passwd",
    ]) {
      const result = await evidence.fetchPage(url, new AbortController().signal)
      expect(result).toMatchObject({ ok: false, code: "SSRF_BLOCKED" })
      if (!result.ok) expect(result.audit[0].hop).toBe(0)
    }
    expect(transport).not.toHaveBeenCalled()
  })

  it("reports a refused redirect as blocked, not as a fetch failure", async () => {
    const evidence = createWebEvidence(
      deps({
        transport: async (input) =>
          String(input).includes("example.com")
            ? redirect("http://10.0.0.5/internal")
            : page("internal"),
        webFetch: (async (args: { url: string }, fetchDeps: { fetchImpl: typeof fetch }) => {
          try {
            await fetchDeps.fetchImpl(args.url)
            return { ok: true, status: 200, text: "leaked" }
          } catch {
            return { ok: false, code: "blocked", error: "blocked" }
          }
        }) as unknown as WebEvidenceDeps["webFetch"],
      })
    )
    const result = await evidence.fetchPage("https://example.com/r", new AbortController().signal)
    expect(result).toEqual({
      ok: false,
      code: "SSRF_BLOCKED",
      message: "the target is not a public address",
      audit: [{ host: "10.0.0.5", reason: "private-host", hop: 1 }],
    })
  })

  it("names HTTP errors, empty pages and failures distinctly", async () => {
    const signal = new AbortController().signal
    const failing = createWebEvidence(
      deps({
        webFetch: (async () => ({
          ok: false,
          code: "execution-failed",
        })) as unknown as WebEvidenceDeps["webFetch"],
      })
    )
    await expect(failing.fetchPage("https://example.com", signal)).resolves.toMatchObject({
      code: "FETCH_FAILED",
    })
    const missing = createWebEvidence(
      deps({
        webFetch: (async () => ({
          ok: false,
          status: 404,
          text: "",
        })) as unknown as WebEvidenceDeps["webFetch"],
      })
    )
    await expect(missing.fetchPage("https://example.com", signal)).resolves.toMatchObject({
      code: "HTTP_ERROR",
    })
    const blank = createWebEvidence(
      deps({
        webFetch: (async () => ({
          ok: true,
          status: 200,
          text: "  ",
        })) as unknown as WebEvidenceDeps["webFetch"],
      })
    )
    await expect(blank.fetchPage("https://example.com", signal)).resolves.toMatchObject({
      code: "EMPTY",
    })
  })

  it("offers search only when a provider is configured", async () => {
    expect(createWebEvidence(deps()).search).toBeUndefined()
    const webSearch = jest.fn(async () => ({
      ok: true,
      results: [{ title: "T", url: "https://example.com/t", content: "4%" }, { title: "no url" }],
    }))
    const evidence = createWebEvidence(
      deps({
        webSearch: webSearch as unknown as WebEvidenceDeps["webSearch"],
        searchExecutor: jest.fn() as unknown as WebEvidenceDeps["searchExecutor"],
      })
    )
    await expect(evidence.search!("tariffs", new AbortController().signal)).resolves.toEqual([
      { title: "T", url: "https://example.com/t", snippet: "4%" },
    ])
    webSearch.mockResolvedValueOnce({ ok: false } as never)
    await expect(evidence.search!("tariffs", new AbortController().signal)).resolves.toBeNull()
  })
})

describe("webEvidenceAvailable", () => {
  const scope = globalThis as unknown as { window?: Record<string, unknown> }

  afterEach(() => {
    delete scope.window
  })

  it("is on for a headless Node brain, whose fetch reports redirects", () => {
    expect(scope.window).toBeUndefined()
    expect(webEvidenceAvailable()).toBe(true)
  })

  it("is on in the desktop window and off in a plain browser tab or the mobile shell", () => {
    scope.window = {}
    expect(webEvidenceAvailable()).toBe(false)
    scope.window = { Capacitor: { isNativePlatform: () => true } }
    expect(webEvidenceAvailable()).toBe(false)
    scope.window = { __TAURI_INTERNALS__: {} }
    expect(webEvidenceAvailable()).toBe(true)
  })
})
