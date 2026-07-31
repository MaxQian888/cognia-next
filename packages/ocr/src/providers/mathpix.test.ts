import { buildMathpixProvider, mathpixExtract } from "./mathpix"
import type { OcrInput, OcrProviderContext } from "../types"

function makeFetch(resp: { status: number; body: unknown }) {
  return jest.fn(async () => {
    return new Response(typeof resp.body === "string" ? resp.body : JSON.stringify(resp.body), {
      status: resp.status,
    })
  }) as unknown as typeof fetch
}

/** Route fetch calls by URL suffix; each handler may be a queue (array). */
function makeRoutedFetch(
  routes: Array<{
    match: (url: string, init?: RequestInit) => boolean
    respond: (url: string, init?: RequestInit) => { status?: number; body: unknown }
  }>
) {
  return jest.fn(async (rawUrl: unknown, init?: RequestInit) => {
    const url = String(rawUrl)
    const route = routes.find((r) => r.match(url, init))
    if (!route) throw new Error(`Unexpected fetch: ${url}`)
    const { status = 200, body } = route.respond(url, init)
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status })
  }) as unknown as typeof fetch
}

function makeCtx(overrides: Partial<OcrProviderContext> = {}): OcrProviderContext {
  return {
    credentials: overrides.credentials ?? { secrets: { appId: "id", appKey: "key" } },
    config: overrides.config ?? {},
    platform: "web",
    signal: overrides.signal,
  }
}

const input: OcrInput = {
  source: { kind: "data-url", dataUrl: "data:image/png;base64,YWJj", mimeType: "image/png" },
  languages: ["en"],
}

const pdfInput: OcrInput = {
  source: {
    kind: "data-url",
    dataUrl: "data:application/pdf;base64,YWJj",
    mimeType: "application/pdf",
  },
  languages: ["en"],
}

/** Config that makes polling instantaneous in tests. */
const pdfConfig = { pollIntervalMs: 0 }

describe("buildMathpixProvider", () => {
  it("declares metadata + credential keys", () => {
    const p = buildMathpixProvider()
    expect(p.id).toBe("mathpix")
    expect(p.category).toBe("specialist")
    expect(p.credentialKeys).toEqual(["appId", "appKey"])
  })
})

describe("mathpixExtract", () => {
  it("returns text + LaTeX-stripped plain text", async () => {
    const fetchImpl = makeFetch({
      status: 200,
      body: { text: "Hello $x=1$ world" },
    })
    const result = await mathpixExtract(input, makeCtx(), fetchImpl)
    expect(result.providerId).toBe("mathpix")
    expect(result.pages[0]!.markdown).toContain("$x=1$")
    expect(result.pages[0]!.text).not.toContain("$")
    expect(result.costEstimate?.unit).toBe("image")
  })

  it("attaches app_id and app_key headers", async () => {
    let seen: Headers | undefined
    const fetchImpl = jest.fn(async (_url, init: RequestInit | undefined) => {
      seen = new Headers(init?.headers)
      return new Response(JSON.stringify({ text: "" }), { status: 200 })
    }) as unknown as typeof fetch
    await mathpixExtract(input, makeCtx(), fetchImpl)
    expect(seen?.get("app_id")).toBe("id")
    expect(seen?.get("app_key")).toBe("key")
  })

  it("throws missing_credentials when appKey is missing", async () => {
    const fetchImpl = makeFetch({ status: 200, body: { text: "" } })
    await expect(
      mathpixExtract(input, makeCtx({ credentials: { secrets: { appId: "id" } } }), fetchImpl)
    ).rejects.toMatchObject({ code: "missing_credentials" })
  })

  it("maps an error_info rate-limit message to rate_limited", async () => {
    const fetchImpl = makeFetch({
      status: 200,
      body: { error_info: { message: "rate limit exceeded" } },
    })
    await expect(mathpixExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "rate_limited",
    })
  })

  it("maps unauthorized error_info to missing_credentials", async () => {
    const fetchImpl = makeFetch({
      status: 200,
      body: { error_info: { message: "invalid api key" } },
    })
    await expect(mathpixExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "missing_credentials",
    })
  })

  it("maps generic errors to provider_failed", async () => {
    const fetchImpl = makeFetch({
      status: 200,
      body: { error_info: { message: "something else" } },
    })
    await expect(mathpixExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "provider_failed",
    })
  })

  it("rejects images above the documented 2 MB base64 limit before upload", async () => {
    // ~1.5 MB of decoded bytes re-encodes to just over 2 MiB of base64.
    const oversized: OcrInput = {
      source: {
        kind: "data-url",
        dataUrl: `data:image/png;base64,${"A".repeat(2 * 1024 * 1024 + 4)}`,
        mimeType: "image/png",
      },
    }
    const fetchImpl = makeFetch({ status: 200, body: { text: "" } })
    await expect(mathpixExtract(oversized, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "invalid_input",
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe("mathpixExtract — PDF flow (v3/pdf)", () => {
  const submitRoute = (respond?: () => { status?: number; body: unknown }) => ({
    match: (url: string, init?: RequestInit) =>
      url.endsWith("/v3/pdf") && (init?.method ?? "POST") === "POST",
    respond: respond ?? (() => ({ body: { pdf_id: "pdf-123" } })),
  })
  const statusRoute = (bodies: unknown[]) => ({
    match: (url: string, init?: RequestInit) =>
      /\/v3\/pdf\/pdf-123$/.test(url) && init?.method === "GET",
    respond: () => ({ body: bodies.length > 1 ? bodies.shift()! : bodies[0]! }),
  })
  const linesRoute = (body: unknown) => ({
    match: (url: string) => url.endsWith("/v3/pdf/pdf-123.lines.json"),
    respond: () => ({ body }),
  })
  const mmdRoute = (body: string) => ({
    match: (url: string) => url.endsWith("/v3/pdf/pdf-123.mmd"),
    respond: () => ({ body }),
  })

  it("submits multipart, polls to completed, and maps lines.json into per-page results", async () => {
    let submitInit: RequestInit | undefined
    const fetchImpl = makeRoutedFetch([
      {
        ...submitRoute(),
        respond: (_url, init) => {
          submitInit = init
          return { body: { pdf_id: "pdf-123" } }
        },
      },
      statusRoute([
        { status: "split", num_pages: 2, num_pages_completed: 1 },
        { status: "completed", num_pages: 2, num_pages_completed: 2 },
      ]),
      linesRoute({
        pages: [
          {
            page: 1,
            page_width: 612,
            page_height: 792,
            lines: [{ text: "Euler $e^{i\\pi}=-1$", text_display: "Euler $e^{i\\pi}=-1$" }],
          },
          { page: 2, lines: [{ text: "Second page" }, { text: "" }] },
        ],
      }),
    ])
    const result = await mathpixExtract(pdfInput, makeCtx({ config: pdfConfig }), fetchImpl)

    // Submit is multipart form-data with `file` + `options_json` parts.
    expect(submitInit?.body).toBeInstanceOf(FormData)
    const form = submitInit!.body as FormData
    expect(form.get("file")).toBeInstanceOf(Blob)
    const options = JSON.parse(String(form.get("options_json")))
    expect(options.math_inline_delimiters).toEqual(["$", "$"])
    const headers = new Headers(submitInit?.headers)
    expect(headers.get("app_id")).toBe("id")
    expect(headers.get("app_key")).toBe("key")
    // fetch must set the multipart boundary itself.
    expect(headers.get("Content-Type")).toBeNull()

    expect(result.pages).toHaveLength(2)
    expect(result.pages[0]).toMatchObject({ pageNumber: 1, width: 612, height: 792 })
    expect(result.pages[0]!.markdown).toContain("$e^{i\\pi}=-1$")
    expect(result.pages[0]!.text).not.toContain("$")
    expect(result.pages[1]).toMatchObject({ pageNumber: 2, markdown: "Second page" })
    expect(result.costEstimate).toMatchObject({ unit: "page", currency: "USD" })
  })

  it("falls back to the combined .mmd output when lines.json has no pages", async () => {
    const fetchImpl = makeRoutedFetch([
      submitRoute(),
      statusRoute([{ status: "completed" }]),
      linesRoute({ pages: [] }),
      mmdRoute("# Title\n\n$$x^2$$"),
    ])
    const result = await mathpixExtract(pdfInput, makeCtx({ config: pdfConfig }), fetchImpl)
    expect(result.pages).toHaveLength(1)
    expect(result.pages[0]!.markdown).toBe("# Title\n\n$$x^2$$")
    expect(result.pages[0]!.text).not.toContain("$")
  })

  it("throws provider_failed when the PDF status is error", async () => {
    const fetchImpl = makeRoutedFetch([
      submitRoute(),
      statusRoute([{ status: "error", error: "could not read pdf" }]),
    ])
    await expect(
      mathpixExtract(pdfInput, makeCtx({ config: pdfConfig }), fetchImpl)
    ).rejects.toMatchObject({ code: "provider_failed", message: expect.stringContaining("read") })
  })

  it("throws provider_failed when the poll budget is exhausted", async () => {
    const fetchImpl = makeRoutedFetch([submitRoute(), statusRoute([{ status: "split" }])])
    await expect(
      mathpixExtract(pdfInput, makeCtx({ config: { ...pdfConfig, maxPolls: 2 } }), fetchImpl)
    ).rejects.toMatchObject({
      code: "provider_failed",
      message: expect.stringContaining("poll budget"),
    })
    // 1 submit + 2 polls, no result fetch.
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it("throws provider_failed when the submit response has no pdf_id", async () => {
    const fetchImpl = makeRoutedFetch([submitRoute(() => ({ body: {} }))])
    await expect(
      mathpixExtract(pdfInput, makeCtx({ config: pdfConfig }), fetchImpl)
    ).rejects.toMatchObject({ code: "provider_failed", message: expect.stringContaining("pdf_id") })
  })

  it("maps in-body submit errors with the shared error rules", async () => {
    const fetchImpl = makeRoutedFetch([
      submitRoute(() => ({ body: { error_info: { message: "rate limit exceeded" } } })),
    ])
    await expect(
      mathpixExtract(pdfInput, makeCtx({ config: pdfConfig }), fetchImpl)
    ).rejects.toMatchObject({ code: "rate_limited" })
  })

  it("maps submit HTTP statuses to OcrError codes (429 → rate_limited)", async () => {
    const fetchImpl = makeRoutedFetch([submitRoute(() => ({ status: 429, body: "slow down" }))])
    await expect(
      mathpixExtract(pdfInput, makeCtx({ config: pdfConfig }), fetchImpl)
    ).rejects.toMatchObject({ code: "rate_limited" })
  })

  it("throws aborted when the signal is already aborted before submit", async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchImpl = makeRoutedFetch([submitRoute()])
    await expect(
      mathpixExtract(pdfInput, makeCtx({ config: pdfConfig, signal: controller.signal }), fetchImpl)
    ).rejects.toMatchObject({ code: "aborted" })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("throws aborted when the signal aborts during polling", async () => {
    const controller = new AbortController()
    const fetchImpl = makeRoutedFetch([
      {
        ...submitRoute(),
        respond: () => {
          // Abort after the submit succeeds → caught by the poll-loop guard.
          controller.abort()
          return { body: { pdf_id: "pdf-123" } }
        },
      },
    ])
    await expect(
      mathpixExtract(pdfInput, makeCtx({ config: pdfConfig, signal: controller.signal }), fetchImpl)
    ).rejects.toMatchObject({ code: "aborted", message: expect.stringContaining("polling") })
  })

  it("maps a fetch AbortError during submit to aborted", async () => {
    const fetchImpl = jest.fn(async () => {
      throw new DOMException("The operation was aborted.", "AbortError")
    }) as unknown as typeof fetch
    await expect(
      mathpixExtract(pdfInput, makeCtx({ config: pdfConfig }), fetchImpl)
    ).rejects.toMatchObject({ code: "aborted" })
  })

  it("maps a network failure during submit to provider_failed", async () => {
    const fetchImpl = jest.fn(async () => {
      throw new TypeError("fetch failed")
    }) as unknown as typeof fetch
    await expect(
      mathpixExtract(pdfInput, makeCtx({ config: pdfConfig }), fetchImpl)
    ).rejects.toMatchObject({ code: "provider_failed", message: "fetch failed" })
  })
})
