import { buildNanonetsProvider, nanonetsExtract } from "./nanonets"
import type { OcrInput, OcrProviderContext } from "../types"

function makeFetch(resp: { status: number; body: unknown }) {
  return jest.fn(async () => {
    return new Response(typeof resp.body === "string" ? resp.body : JSON.stringify(resp.body), {
      status: resp.status,
    })
  }) as unknown as typeof fetch
}

function makeCtx(overrides: Partial<OcrProviderContext> = {}): OcrProviderContext {
  return {
    credentials: overrides.credentials ?? { secrets: { apiKey: "key" } },
    config: overrides.config ?? {},
    platform: "web",
    signal: overrides.signal,
  }
}

const input: OcrInput = {
  source: { kind: "data-url", dataUrl: "data:image/png;base64,YWJj", mimeType: "image/png" },
  languages: ["en"],
}

describe("buildNanonetsProvider", () => {
  it("declares metadata + credential keys", () => {
    const p = buildNanonetsProvider()
    expect(p.id).toBe("nanonets")
    expect(p.credentialKeys).toEqual(["apiKey"])
  })
})

describe("nanonetsExtract", () => {
  it("parses predictions into blocks with bbox + confidence", async () => {
    const fetchImpl = makeFetch({
      status: 200,
      body: {
        result: [
          {
            page: 1,
            prediction: [
              {
                ocr_text: "Invoice",
                score: 0.95,
                xmin: 10,
                ymin: 20,
                xmax: 60,
                ymax: 40,
              },
              { ocr_text: "Total" },
            ],
          },
        ],
      },
    })
    const result = await nanonetsExtract(input, makeCtx(), fetchImpl)
    expect(result.pages[0]!.text).toContain("Invoice")
    expect(result.pages[0]!.text).toContain("Total")
    expect(result.pages[0]!.blocks?.[0]?.bbox).toEqual({ x: 10, y: 20, width: 50, height: 20 })
    expect(result.pages[0]!.blocks?.[0]?.confidence).toBe(0.95)
  })

  it("sends multipart/form-data with Basic auth header", async () => {
    let seen: Headers | undefined
    const fetchImpl = jest.fn(async (_url, init: RequestInit | undefined) => {
      seen = new Headers(init?.headers)
      return new Response(JSON.stringify({ result: [] }), { status: 200 })
    }) as unknown as typeof fetch
    await nanonetsExtract(input, makeCtx(), fetchImpl)
    expect(seen?.get("content-type")).toMatch(/^multipart\/form-data; boundary=/)
    expect(seen?.get("authorization")?.startsWith("Basic ")).toBe(true)
  })

  it("uses a custom modelId in the URL when provided", async () => {
    let seenUrl = ""
    const fetchImpl = jest.fn(async (url: RequestInfo | URL) => {
      seenUrl = typeof url === "string" ? url : url.toString()
      return new Response(JSON.stringify({ result: [] }), { status: 200 })
    }) as unknown as typeof fetch
    await nanonetsExtract(input, makeCtx({ config: { modelId: "abc-123" } }), fetchImpl)
    expect(seenUrl).toContain("/Model/abc-123/")
  })

  it("throws missing_credentials when apiKey is absent", async () => {
    const fetchImpl = makeFetch({ status: 200, body: { result: [] } })
    await expect(
      nanonetsExtract(input, makeCtx({ credentials: { secrets: {} } }), fetchImpl)
    ).rejects.toMatchObject({ code: "missing_credentials" })
  })

  it("maps HTTP 401 to missing_credentials", async () => {
    const fetchImpl = makeFetch({ status: 401, body: "no" })
    await expect(nanonetsExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "missing_credentials",
    })
  })

  it("maps HTTP 429 to rate_limited", async () => {
    const fetchImpl = makeFetch({ status: 429, body: "slow" })
    await expect(nanonetsExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "rate_limited",
    })
  })

  it("maps an error response body to provider_failed", async () => {
    const fetchImpl = makeFetch({ status: 200, body: { error: "boom" } })
    await expect(nanonetsExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "provider_failed",
    })
  })
})
