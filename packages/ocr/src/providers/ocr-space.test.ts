import { buildOcrSpaceProvider, ocrSpaceExtract } from "./ocr-space"
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

describe("buildOcrSpaceProvider", () => {
  it("declares the right metadata", () => {
    const p = buildOcrSpaceProvider()
    expect(p.id).toBe("ocr-space")
    expect(p.category).toBe("specialist")
  })
})

describe("ocrSpaceExtract", () => {
  it("returns text from ParsedResults", async () => {
    const fetchImpl = makeFetch({
      status: 200,
      body: { ParsedResults: [{ ParsedText: "Hello world" }], IsErroredOnProcessing: false },
    })
    const result = await ocrSpaceExtract(input, makeCtx(), fetchImpl)
    expect(result.pages[0]!.text).toBe("Hello world")
  })

  it("joins multi-result ParsedText with newlines", async () => {
    const fetchImpl = makeFetch({
      status: 200,
      body: {
        ParsedResults: [{ ParsedText: "Page1" }, { ParsedText: "Page2" }],
        IsErroredOnProcessing: false,
      },
    })
    const result = await ocrSpaceExtract(input, makeCtx(), fetchImpl)
    expect(result.pages[0]!.text).toBe("Page1\nPage2")
  })

  it("maps Chinese languages to OCR.space's chs code", async () => {
    let body = ""
    const fetchImpl = jest.fn(async (_url, init: RequestInit | undefined) => {
      body = init?.body as string
      return new Response(JSON.stringify({ ParsedResults: [], IsErroredOnProcessing: false }), {
        status: 200,
      })
    }) as unknown as typeof fetch
    await ocrSpaceExtract({ ...input, languages: ["zh"] }, makeCtx(), fetchImpl)
    expect(body).toContain("language=chs")
  })

  it("maps unsupported-language errors to unsupported_language", async () => {
    const fetchImpl = makeFetch({
      status: 200,
      body: { IsErroredOnProcessing: true, ErrorMessage: ["Language not supported"] },
    })
    await expect(ocrSpaceExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "unsupported_language",
    })
  })

  it("maps apikey errors to missing_credentials", async () => {
    const fetchImpl = makeFetch({
      status: 200,
      body: { IsErroredOnProcessing: true, ErrorMessage: "Invalid apikey" },
    })
    await expect(ocrSpaceExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "missing_credentials",
    })
  })

  it("maps rate-limit messages to rate_limited", async () => {
    const fetchImpl = makeFetch({
      status: 200,
      body: { IsErroredOnProcessing: true, ErrorMessage: "rate limit exceeded" },
    })
    await expect(ocrSpaceExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "rate_limited",
    })
  })

  it("throws missing_credentials when no apiKey is configured", async () => {
    const fetchImpl = makeFetch({ status: 200, body: { ParsedResults: [] } })
    await expect(
      ocrSpaceExtract(input, makeCtx({ credentials: { secrets: {} } }), fetchImpl)
    ).rejects.toMatchObject({ code: "missing_credentials" })
  })
})
