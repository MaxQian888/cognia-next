import { mistralExtract, buildMistralOcrProvider } from "./mistral-ocr"
import type { OcrProviderContext } from "@/types/ocr"

function makeFetch(resp: { status: number; body: unknown; headers?: Record<string, string> }) {
  return jest.fn(async () => {
    return new Response(typeof resp.body === "string" ? resp.body : JSON.stringify(resp.body), {
      status: resp.status,
      headers: resp.headers,
    })
  }) as unknown as typeof fetch
}

function makeCtx(overrides: Partial<OcrProviderContext> = {}): OcrProviderContext {
  return {
    credentials: overrides.credentials ?? { secrets: { apiKey: "test-key" } },
    config: overrides.config ?? {},
    platform: overrides.platform ?? "web",
    signal: overrides.signal,
  }
}

const dataUrlInput = {
  source: {
    kind: "data-url" as const,
    dataUrl: "data:image/png;base64,YWJj",
    mimeType: "image/png",
  },
  languages: ["en"],
}

describe("buildMistralOcrProvider", () => {
  it("declares browser/tauri/capacitor shell support", () => {
    const p = buildMistralOcrProvider()
    expect(p.id).toBe("mistral-ocr")
    expect(p.category).toBe("document-cloud")
    expect(p.shells).toEqual({ browser: true, tauri: true, capacitor: true })
    expect(p.credentialKeys).toEqual(["apiKey"])
  })
})

describe("mistralExtract — success", () => {
  it("returns per-page Markdown and a cost estimate", async () => {
    const fetchImpl = makeFetch({
      status: 200,
      body: {
        pages: [
          { index: 0, markdown: "# Hello\nworld" },
          { index: 1, markdown: "## Page two" },
        ],
        usage_info: { pages_processed: 2, doc_size_bytes: 1234 },
      },
    })
    const result = await mistralExtract(dataUrlInput, makeCtx(), fetchImpl)
    expect(result.providerId).toBe("mistral-ocr")
    expect(result.pages).toHaveLength(2)
    expect(result.pages[0]!.pageNumber).toBe(1)
    expect(result.pages[0]!.markdown).toContain("Hello")
    expect(result.pages[0]!.text).toContain("Hello")
    expect(result.pages[0]!.text).not.toContain("#")
    expect(result.costEstimate?.unit).toBe("page")
    // 2 pages × $0.004/page ($4 per 1000 pages).
    expect(result.costEstimate?.amount).toBeCloseTo(0.008)
  })

  it("sends the official default model alias when none is configured", async () => {
    const seen: { body?: string } = {}
    const fetchImpl = jest.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      seen.body = init?.body as string
      return new Response(JSON.stringify({ pages: [] }), { status: 200 })
    }) as unknown as typeof fetch
    await mistralExtract(dataUrlInput, makeCtx(), fetchImpl)
    expect(JSON.parse(seen.body!).model).toBe("mistral-ocr-latest")
  })

  it("falls back to positional page numbers when index is missing", async () => {
    const fetchImpl = makeFetch({
      status: 200,
      body: { pages: [{ markdown: "a" }, { markdown: "b" }] },
    })
    const result = await mistralExtract(dataUrlInput, makeCtx(), fetchImpl)
    expect(result.pages.map((p) => p.pageNumber)).toEqual([1, 2])
  })

  it("targets document_url for PDF inputs", async () => {
    const seen: { body?: string } = {}
    const fetchImpl = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.body = init?.body as string
      return new Response(JSON.stringify({ pages: [{ index: 0, markdown: "ok" }] }), {
        status: 200,
      })
    }) as unknown as typeof fetch
    await mistralExtract(
      {
        source: {
          kind: "data-url",
          dataUrl: "data:application/pdf;base64,JVBERi0x",
          mimeType: "application/pdf",
        },
      },
      makeCtx(),
      fetchImpl
    )
    expect(seen.body).toContain("document_url")
    expect(seen.body).not.toContain('"image_url":')
  })

  it("uses the configured model when provided", async () => {
    const seen: { body?: string } = {}
    const fetchImpl = jest.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      seen.body = init?.body as string
      return new Response(JSON.stringify({ pages: [] }), { status: 200 })
    }) as unknown as typeof fetch
    await mistralExtract(
      dataUrlInput,
      makeCtx({ config: { model: "mistral-ocr-custom" } }),
      fetchImpl
    )
    expect(seen.body).toContain("mistral-ocr-custom")
  })

  it("includes the bearer auth header", async () => {
    const seen: { headers?: Headers } = {}
    const fetchImpl = jest.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      seen.headers = new Headers(init?.headers)
      return new Response(JSON.stringify({ pages: [] }), { status: 200 })
    }) as unknown as typeof fetch
    await mistralExtract(dataUrlInput, makeCtx(), fetchImpl)
    expect(seen.headers?.get("authorization")).toBe("Bearer test-key")
  })
})

describe("mistralExtract — error paths", () => {
  it("throws missing_credentials when apiKey is absent", async () => {
    const fetchImpl = makeFetch({ status: 200, body: { pages: [] } })
    await expect(
      mistralExtract(dataUrlInput, makeCtx({ credentials: { secrets: {} } }), fetchImpl)
    ).rejects.toMatchObject({ code: "missing_credentials" })
  })

  it("maps 429 to rate_limited", async () => {
    const fetchImpl = makeFetch({ status: 429, body: "slow down" })
    await expect(mistralExtract(dataUrlInput, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "rate_limited",
    })
  })

  it("maps 400 to invalid_input (used for unsupported_language by Mistral)", async () => {
    const fetchImpl = makeFetch({ status: 400, body: { error: "bad lang" } })
    await expect(mistralExtract(dataUrlInput, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "invalid_input",
    })
  })

  it("maps 500 to provider_failed", async () => {
    const fetchImpl = makeFetch({ status: 500, body: "boom" })
    await expect(mistralExtract(dataUrlInput, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "provider_failed",
    })
  })

  it("throws provider_failed when the body isn't JSON", async () => {
    const fetchImpl = makeFetch({ status: 200, body: "not-json" })
    await expect(mistralExtract(dataUrlInput, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "provider_failed",
    })
  })
})
