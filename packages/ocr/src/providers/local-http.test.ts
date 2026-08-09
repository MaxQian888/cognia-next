import {
  __setLocalHttpTransport,
  buildLocalHttpProvider,
  mapUmiLanguageOption,
  localHttpExtract,
  parseResponse,
  serializeRequest,
  type LocalHttpTransportRequest,
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
    expect(p.credentialKeys).toEqual(["apiKey"])
  })
})

describe("localHttpExtract", () => {
  afterEach(() => {
    __setLocalHttpTransport(null)
  })

  it("uses the native transport on Tauri and confirms only the saved LAN endpoint", async () => {
    const transport = {
      request: jest.fn(async (_request: LocalHttpTransportRequest) => ({
        status: 200,
        body: JSON.stringify({ code: 100, data: "native" }),
        contentType: "application/json",
      })),
      cancel: jest.fn(async () => true),
    }
    __setLocalHttpTransport(transport)

    const endpoint = "http://192.168.1.20:1224/api/ocr"
    const result = await localHttpExtract(baseInput, {
      credentials: { secrets: {} },
      config: {
        endpoint,
        dialect: "umi-ocr",
        allowLan: true,
        confirmedLanEndpoint: endpoint,
      },
      platform: "tauri",
    })

    expect(result.pages[0]!.text).toBe("native")
    const calls = transport.request.mock.calls.map(([request]) => request)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({
      url: "http://192.168.1.20:1224/api/ocr/get_options",
      method: "GET",
      allowPrivateNetwork: true,
    })
    expect(calls[1]).toMatchObject({ url: endpoint, method: "POST", allowPrivateNetwork: true })
  })

  it("does not carry LAN confirmation across endpoint changes", async () => {
    const transport = {
      request: jest.fn(async (request: { method: string }) => ({
        status: 200,
        body: JSON.stringify(request.method === "GET" ? {} : { code: 100, data: "native" }),
        contentType: "application/json",
      })),
      cancel: jest.fn(async () => false),
    }
    __setLocalHttpTransport(transport)

    await localHttpExtract(baseInput, {
      credentials: { secrets: {} },
      config: {
        endpoint: "http://192.168.1.21:1224/api/ocr",
        allowLan: true,
        confirmedLanEndpoint: "http://192.168.1.20:1224/api/ocr",
      },
      platform: "tauri",
    })

    expect(transport.request).toHaveBeenCalledWith(
      expect.objectContaining({ allowPrivateNetwork: false })
    )
  })

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
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const [url, init] = (fetchImpl as jest.Mock).mock.calls[1]!
    expect(url).toBe("http://localhost:1224/api/ocr")
    expect((init as RequestInit).method).toBe("POST")
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers["Authorization"]).toBe("Bearer test-key")
    expect(headers["Content-Type"]).toBe("application/json")
    expect(result.pages[0]!.text).toBe("hello")
  })

  it("prefers the keyring credential over a legacy plaintext config key", async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({ code: 100, data: "hello" })
    ) as unknown as typeof fetch
    await localHttpExtract(baseInput, {
      credentials: { secrets: { apiKey: "keyring-key" } },
      config: {
        endpoint: "http://localhost:1224/api/ocr",
        apiKey: "legacy-key",
        fetchImpl,
      },
      platform: "tauri",
    })
    const headers = (fetchImpl as jest.Mock).mock.calls[0]![1].headers as Record<string, string>
    expect(headers.Authorization).toBe("Bearer keyring-key")
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

  it("preserves Umi-OCR line end markers when rebuilding layout text", async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({
        code: 100,
        data: [
          { text: "first", end: " " },
          { text: "paragraph", end: "\n" },
          { text: "second", end: "" },
        ],
      })
    ) as unknown as typeof fetch
    const result = await localHttpExtract(baseInput, {
      credentials: { secrets: {} },
      config: { endpoint: "http://localhost:1224/api/ocr", dialect: "umi-ocr", fetchImpl },
      platform: "tauri",
    })
    expect(result.pages[0]!.text).toBe("first paragraph\nsecond")
  })

  it("discovers Umi-OCR language model values before recognition", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          "ocr.language": {
            type: "enum",
            default: "models/config_chinese.txt",
            optionsList: [
              ["models/config_chinese.txt", "简体中文"],
              ["models/config_en.txt", "English"],
            ],
          },
        })
      )
      .mockResolvedValueOnce(jsonResponse({ code: 100, data: "hello" }))
    const fetchImpl = fetchMock as unknown as typeof fetch

    await localHttpExtract(baseInput, {
      credentials: { secrets: {} },
      config: { endpoint: "http://localhost:1224/api/ocr", dialect: "umi-ocr", fetchImpl },
      platform: "web",
    })

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "http://localhost:1224/api/ocr/get_options",
      expect.objectContaining({ method: "GET" })
    )
    const recognitionBody = JSON.parse(String(fetchMock.mock.calls[1]![1]!.body))
    expect(recognitionBody.options).toEqual({ "ocr.language": "models/config_en.txt" })
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

  it("uses and parses the PaddleOCR 3.x serving contract", async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({
        logId: "request-1",
        errorCode: 0,
        errorMsg: "Success",
        result: {
          ocrResults: [
            {
              prunedResult: {
                rec_texts: ["hello", "world"],
                rec_scores: [0.96, 0.88],
                rec_polys: [
                  [
                    [10, 5],
                    [50, 5],
                    [50, 15],
                    [10, 15],
                  ],
                  [
                    [2, 20],
                    [42, 20],
                    [42, 30],
                    [2, 30],
                  ],
                ],
              },
            },
          ],
        },
      })
    ) as unknown as typeof fetch

    const result = await localHttpExtract(baseInput, {
      credentials: { secrets: {} },
      config: {
        endpoint: "http://localhost:8080/ocr",
        dialect: "paddleocr-server",
        fetchImpl,
      },
      platform: "web",
    })

    const requestBody = JSON.parse(String((fetchImpl as jest.Mock).mock.calls[0]![1].body))
    expect(requestBody).toMatchObject({ file: expect.any(String), fileType: 1, visualize: false })
    expect(requestBody.images).toBeUndefined()
    expect(result.pages[0]!.text).toBe("hello\nworld")
    expect(result.pages[0]!.blocks?.[0]).toMatchObject({
      confidence: 0.96,
      bbox: { x: 10, y: 5, width: 40, height: 10 },
    })
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

  it("encodes PaddleOCR 3.x serving payload", () => {
    const bundle = serializeRequest(
      "paddleocr-server",
      new Uint8Array([1, 2, 3]),
      "image/png",
      ["en"],
      "key-x"
    )
    expect(bundle.headers["Authorization"]).toBe("Bearer key-x")
    const parsed = JSON.parse(String(bundle.body))
    expect(parsed).toMatchObject({ file: expect.any(String), fileType: 1, visualize: false })
    expect(parsed.images).toBeUndefined()
  })
})

describe("mapUmiLanguageOption", () => {
  const options = [
    ["models/config_chinese.txt", "简体中文"],
    ["models/config_en.txt", "English"],
    ["models/config_chinese_cht(v2).txt", "繁體中文"],
    ["models/config_japan.txt", "日本語"],
  ] as Array<[unknown, unknown]>

  it.each([
    ["en-US", "models/config_en.txt"],
    ["zh-CN", "models/config_chinese.txt"],
    ["zh-Hant", "models/config_chinese_cht(v2).txt"],
    ["ja-JP", "models/config_japan.txt"],
  ])("maps %s to the server-advertised model value", (language, expected) => {
    expect(mapUmiLanguageOption(language, options)).toBe(expected)
  })
})

describe("parseResponse", () => {
  it("throws provider_failed on invalid JSON", () => {
    expect(() => parseResponse("umi-ocr", "not json")).toThrow(/JSON/)
  })
})
