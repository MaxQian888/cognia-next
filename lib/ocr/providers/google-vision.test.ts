import { buildGoogleVisionProvider, googleVisionExtract } from "./google-vision"
import type { OcrProviderContext } from "@/types/ocr"

function makeFetch(resp: { status: number; body: unknown }) {
  return jest.fn(async () => {
    return new Response(typeof resp.body === "string" ? resp.body : JSON.stringify(resp.body), {
      status: resp.status,
    })
  }) as unknown as typeof fetch
}

function makeCtx(overrides: Partial<OcrProviderContext> = {}): OcrProviderContext {
  return {
    credentials: overrides.credentials ?? { secrets: { apiKey: "test" } },
    config: overrides.config ?? {},
    platform: overrides.platform ?? "web",
    signal: overrides.signal,
  }
}

const input = {
  source: {
    kind: "data-url" as const,
    dataUrl: "data:image/png;base64,YWJj",
    mimeType: "image/png",
  },
  languages: ["en"],
}

describe("buildGoogleVisionProvider", () => {
  it("declares provider metadata", () => {
    const p = buildGoogleVisionProvider()
    expect(p.id).toBe("google-vision")
    expect(p.category).toBe("document-cloud")
    expect(p.credentialKeys).toEqual(["apiKey"])
  })
})

describe("googleVisionExtract — success", () => {
  it("returns paragraph text + bounding boxes", async () => {
    const fetchImpl = makeFetch({
      status: 200,
      body: {
        responses: [
          {
            fullTextAnnotation: {
              text: "Hello world",
              pages: [
                {
                  width: 100,
                  height: 200,
                  blocks: [
                    {
                      paragraphs: [
                        {
                          confidence: 0.9,
                          boundingBox: {
                            vertices: [
                              { x: 1, y: 2 },
                              { x: 10, y: 2 },
                              { x: 10, y: 8 },
                              { x: 1, y: 8 },
                            ],
                          },
                          words: [
                            { symbols: [{ text: "H" }, { text: "i" }] },
                            { symbols: [{ text: "!" }] },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    })
    const result = await googleVisionExtract(input, makeCtx(), fetchImpl)
    expect(result.providerId).toBe("google-vision")
    expect(result.pages).toHaveLength(1)
    expect(result.pages[0]!.text).toContain("Hi !")
    expect(result.pages[0]!.blocks?.[0]?.bbox).toEqual({ x: 1, y: 2, width: 9, height: 6 })
    expect(result.pages[0]!.blocks?.[0]?.confidence).toBe(0.9)
    expect(result.pages[0]!.width).toBe(100)
  })

  it("falls back to a synthetic single-page result when pages are missing", async () => {
    const fetchImpl = makeFetch({
      status: 200,
      body: { responses: [{ fullTextAnnotation: { text: "raw text only" } }] },
    })
    const result = await googleVisionExtract(input, makeCtx(), fetchImpl)
    expect(result.pages).toHaveLength(1)
    expect(result.pages[0]!.text).toBe("raw text only")
  })

  it("returns an empty page when response is empty", async () => {
    const fetchImpl = makeFetch({ status: 200, body: { responses: [] } })
    const result = await googleVisionExtract(input, makeCtx(), fetchImpl)
    expect(result.pages[0]!.text).toBe("")
  })

  it("forwards the API key as the `?key=` query parameter", async () => {
    let seenUrl = ""
    const fetchImpl = jest.fn(async (url: RequestInfo | URL) => {
      seenUrl = typeof url === "string" ? url : url.toString()
      return new Response(JSON.stringify({ responses: [] }), { status: 200 })
    }) as unknown as typeof fetch
    await googleVisionExtract(input, makeCtx(), fetchImpl)
    expect(seenUrl).toContain("?key=test")
  })

  it("respects a configured TEXT_DETECTION featureType", async () => {
    let seenBody = ""
    const fetchImpl = jest.fn(async (_url, init: RequestInit | undefined) => {
      seenBody = init?.body as string
      return new Response(JSON.stringify({ responses: [{ fullTextAnnotation: { text: "" } }] }), {
        status: 200,
      })
    }) as unknown as typeof fetch
    await googleVisionExtract(
      input,
      makeCtx({ config: { featureType: "TEXT_DETECTION" } }),
      fetchImpl
    )
    expect(seenBody).toContain("TEXT_DETECTION")
  })
})

describe("googleVisionExtract — error paths", () => {
  it("throws missing_credentials when no apiKey is configured", async () => {
    const fetchImpl = makeFetch({ status: 200, body: { responses: [] } })
    await expect(
      googleVisionExtract(input, makeCtx({ credentials: { secrets: {} } }), fetchImpl)
    ).rejects.toMatchObject({ code: "missing_credentials" })
  })

  it("maps the per-response error.code=429 to rate_limited", async () => {
    const fetchImpl = makeFetch({
      status: 200,
      body: { responses: [{ error: { code: 429, message: "Too many" } }] },
    })
    await expect(googleVisionExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "rate_limited",
    })
  })

  it("maps other per-response errors to provider_failed", async () => {
    const fetchImpl = makeFetch({
      status: 200,
      body: { responses: [{ error: { code: 3, message: "bad request" } }] },
    })
    await expect(googleVisionExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "provider_failed",
    })
  })

  it("maps HTTP 401 to missing_credentials", async () => {
    const fetchImpl = makeFetch({ status: 401, body: "unauthorized" })
    await expect(googleVisionExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "missing_credentials",
    })
  })

  it("maps HTTP 400 (Google's unsupported-language) to invalid_input", async () => {
    const fetchImpl = makeFetch({ status: 400, body: { error: "bad lang" } })
    await expect(googleVisionExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "invalid_input",
    })
  })
})
