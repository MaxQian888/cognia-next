import {
  buildLocalHttpProvider,
  localHttpExtract,
  parseResponse,
  serializeRequest,
} from "./local-http"
import type { OcrInput, OcrProviderContext } from "../types"

const baseInput: OcrInput = {
  source: { kind: "data-url", dataUrl: "data:image/png;base64,YWJj", mimeType: "image/png" },
  languages: ["en"],
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("buildLocalHttpProvider", () => {
  it("declares a local provider available on all shells", () => {
    const p = buildLocalHttpProvider()
    expect(p.id).toBe("local-http")
    expect(p.category).toBe("local")
    expect(p.shells).toEqual({ browser: true, tauri: true, capacitor: true })
    expect(p.credentialKeys).toEqual([])
  })
})

describe("localHttpExtract", () => {
  it("rejects with invalid_input when endpoint is missing", async () => {
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: {},
      platform: "tauri",
    }
    await expect(localHttpExtract(baseInput, ctx)).rejects.toMatchObject({
      code: "invalid_input",
      providerId: "local-http",
    })
  })

  it("posts to the configured endpoint with bearer auth when apiKey is set", async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({ code: 100, data: "hello" })
    ) as unknown as typeof fetch
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: {
        endpoint: "http://localhost:1224/api/ocr",
        dialect: "umi-ocr",
        apiKey: "test-key",
        fetchImpl,
      },
      platform: "tauri",
    }
    const result = await localHttpExtract(baseInput, ctx)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = (fetchImpl as jest.Mock).mock.calls[0]!
    expect(url).toBe("http://localhost:1224/api/ocr")
    expect((init as RequestInit).method).toBe("POST")
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers["Authorization"]).toBe("Bearer test-key")
    expect(headers["Content-Type"]).toBe("application/json")
    expect(result.pages[0]!.text).toBe("hello")
  })

  it("parses Umi-OCR line list with bounding boxes", async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({
        code: 100,
        data: [
          {
            text: "first",
            score: 0.9,
            box: [
              [0, 0],
              [10, 0],
              [10, 5],
              [0, 5],
            ],
          },
          {
            text: "second",
            score: 0.8,
            box: [
              [0, 10],
              [12, 10],
              [12, 16],
              [0, 16],
            ],
          },
        ],
      })
    ) as unknown as typeof fetch
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: {
        endpoint: "http://localhost:1224/api/ocr",
        dialect: "umi-ocr",
        fetchImpl,
      },
      platform: "tauri",
    }
    const result = await localHttpExtract(baseInput, ctx)
    expect(result.pages[0]!.text).toBe("first\nsecond")
    expect(result.pages[0]!.blocks).toHaveLength(2)
    expect(result.pages[0]!.blocks?.[0]?.bbox).toEqual({
      x: 0,
      y: 0,
      width: 10,
      height: 5,
    })
    expect(result.pages[0]!.blocks?.[0]?.confidence).toBeCloseTo(0.9)
  })

  it("returns empty result when Umi-OCR reports code=101 (no text)", async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({ code: 101, data: "" })
    ) as unknown as typeof fetch
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: { endpoint: "http://localhost:1224/api/ocr", dialect: "umi-ocr", fetchImpl },
      platform: "tauri",
    }
    const result = await localHttpExtract(baseInput, ctx)
    expect(result.pages[0]!.text).toBe("")
    expect(result.pages[0]!.blocks).toEqual([])
  })

  it("raises provider_failed on Umi-OCR error codes", async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({ code: 201, data: "" as unknown as string, message: "bad image" })
    ) as unknown as typeof fetch
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: { endpoint: "http://localhost:1224/api/ocr", dialect: "umi-ocr", fetchImpl },
      platform: "tauri",
    }
    await expect(localHttpExtract(baseInput, ctx)).rejects.toMatchObject({
      code: "provider_failed",
      providerId: "local-http",
    })
  })

  it("parses PaddleOCR-Server nested results", async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({
        status: "000",
        results: [
          [
            [
              [
                [10, 5],
                [50, 5],
                [50, 15],
                [10, 15],
              ],
              ["hello", 0.95],
            ],
          ],
        ],
      })
    ) as unknown as typeof fetch
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: {
        endpoint: "http://localhost:8868/predict/ocr_system",
        dialect: "paddleocr-server",
        fetchImpl,
      },
      platform: "tauri",
    }
    const result = await localHttpExtract(baseInput, ctx)
    expect(result.pages[0]!.text).toBe("hello")
    expect(result.pages[0]!.blocks?.[0]?.confidence).toBeCloseTo(0.95)
    expect(result.pages[0]!.blocks?.[0]?.bbox).toEqual({
      x: 10,
      y: 5,
      width: 40,
      height: 10,
    })
  })

  it("parses official hubserving dict-shaped PaddleOCR-Server results", async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({
        status: "000",
        results: [
          [
            {
              text: "hello",
              confidence: 0.95,
              text_region: [
                [10, 5],
                [50, 5],
                [50, 15],
                [10, 15],
              ],
            },
            { text: "world", confidence: 0.8 },
          ],
        ],
      })
    ) as unknown as typeof fetch
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: {
        endpoint: "http://localhost:8868/predict/ocr_system",
        dialect: "paddleocr-server",
        fetchImpl,
      },
      platform: "tauri",
    }
    const result = await localHttpExtract(baseInput, ctx)
    expect(result.pages[0]!.text).toBe("hello\nworld")
    expect(result.pages[0]!.blocks).toHaveLength(2)
    expect(result.pages[0]!.blocks?.[0]?.confidence).toBeCloseTo(0.95)
    expect(result.pages[0]!.blocks?.[0]?.bbox).toEqual({
      x: 10,
      y: 5,
      width: 40,
      height: 10,
    })
    expect(result.pages[0]!.blocks?.[1]?.bbox).toBeUndefined()
  })

  it("raises provider_failed when all PaddleOCR-Server entries are unparseable", async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({
        status: "000",
        results: [[{ unexpected: true }, 42, null]],
      })
    ) as unknown as typeof fetch
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: {
        endpoint: "http://localhost:8868/predict/ocr_system",
        dialect: "paddleocr-server",
        fetchImpl,
      },
      platform: "tauri",
    }
    await expect(localHttpExtract(baseInput, ctx)).rejects.toMatchObject({
      code: "provider_failed",
      providerId: "local-http",
    })
  })

  it("maps 401 to missing_credentials", async () => {
    const fetchImpl = jest.fn(
      async () => new Response("unauthorized", { status: 401 })
    ) as unknown as typeof fetch
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: { endpoint: "http://localhost:1224/api/ocr", dialect: "umi-ocr", fetchImpl },
      platform: "tauri",
    }
    await expect(localHttpExtract(baseInput, ctx)).rejects.toMatchObject({
      code: "missing_credentials",
      providerId: "local-http",
    })
  })

  it("maps 500 to provider_failed", async () => {
    const fetchImpl = jest.fn(
      async () => new Response("boom", { status: 500 })
    ) as unknown as typeof fetch
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: { endpoint: "http://localhost:1224/api/ocr", dialect: "umi-ocr", fetchImpl },
      platform: "tauri",
    }
    await expect(localHttpExtract(baseInput, ctx)).rejects.toMatchObject({
      code: "provider_failed",
      providerId: "local-http",
    })
  })

  it("propagates fetch failures as provider_failed", async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error("DNS lookup failed")
    }) as unknown as typeof fetch
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: { endpoint: "http://nope.invalid/api", dialect: "umi-ocr", fetchImpl },
      platform: "tauri",
    }
    await expect(localHttpExtract(baseInput, ctx)).rejects.toMatchObject({
      code: "provider_failed",
      providerId: "local-http",
    })
  })

  it("rejects with aborted when signal is already aborted", async () => {
    const fetchImpl = jest.fn() as unknown as typeof fetch
    const ctrl = new AbortController()
    ctrl.abort()
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: { endpoint: "http://localhost:1224/api/ocr", dialect: "umi-ocr", fetchImpl },
      platform: "tauri",
      signal: ctrl.signal,
    }
    await expect(localHttpExtract(baseInput, ctx)).rejects.toMatchObject({
      code: "aborted",
      providerId: "local-http",
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe("serializeRequest", () => {
  it("encodes base64 + lang under Umi-OCR's documented 'ocr.language' option key", () => {
    const bundle = serializeRequest("umi-ocr", new Uint8Array([1, 2, 3]), "image/png", ["zh-cn"])
    expect(bundle.headers["Content-Type"]).toBe("application/json")
    const parsed = JSON.parse(String(bundle.body))
    expect(parsed).toMatchObject({
      base64: expect.any(String),
      options: { "ocr.language": "zh-cn" },
    })
    expect(parsed.options.language).toBeUndefined()
  })

  it("omits Umi-OCR options entirely when no languages are provided", () => {
    const bundle = serializeRequest("umi-ocr", new Uint8Array([1, 2, 3]), "image/png", [])
    const parsed = JSON.parse(String(bundle.body))
    expect(parsed.options).toBeUndefined()
  })

  it("encodes PaddleOCR-Server payload with images array", () => {
    const bundle = serializeRequest(
      "paddleocr-server",
      new Uint8Array([1, 2, 3]),
      "image/png",
      ["en"],
      "key-x"
    )
    expect(bundle.headers["Authorization"]).toBe("Bearer key-x")
    const parsed = JSON.parse(String(bundle.body))
    expect(parsed.images).toHaveLength(1)
  })
})

describe("parseResponse", () => {
  it("throws provider_failed on invalid JSON", () => {
    expect(() => parseResponse("umi-ocr", "not json")).toThrow(/JSON/)
  })
})
