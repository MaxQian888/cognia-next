import { generateOllamaEmbedding } from "./ollama"

jest.mock("@/lib/network/proxy-fetch", () => ({
  __esModule: true,
  proxyFetch: jest.fn(),
}))

import { proxyFetch as proxyFetchMock } from "@/lib/network/proxy-fetch"

const proxyFetch = proxyFetchMock as unknown as jest.Mock

function makeResponse(init: {
  status?: number
  statusText?: string
  body?: unknown
  rawText?: string
  jsonThrows?: boolean
}): Response {
  const status = init.status ?? 200
  const ok = status >= 200 && status < 300
  return {
    ok,
    status,
    statusText: init.statusText ?? "",
    json: async () => {
      if (init.jsonThrows) throw new Error("invalid json")
      return init.body
    },
    text: async () => init.rawText ?? JSON.stringify(init.body ?? ""),
  } as unknown as Response
}

describe("generateOllamaEmbedding", () => {
  beforeEach(() => {
    proxyFetch.mockReset()
  })

  it("posts JSON to {baseURL}/api/embeddings and returns the embedding array", async () => {
    proxyFetch.mockResolvedValue(makeResponse({ body: { embedding: [0.1, 0.2, 0.3] } }))

    const out = await generateOllamaEmbedding("http://localhost:11434", "nomic-embed-text", "hello")

    expect(out).toEqual([0.1, 0.2, 0.3])
    const call = proxyFetch.mock.calls[0]
    expect(call[0]).toBe("http://localhost:11434/api/embeddings")
    expect(call[1].method).toBe("POST")
    expect(call[1].headers).toEqual({ "Content-Type": "application/json" })
    expect(JSON.parse(call[1].body as string)).toEqual({
      model: "nomic-embed-text",
      prompt: "hello",
    })
  })

  it("strips a trailing slash on baseURL", async () => {
    proxyFetch.mockResolvedValue(makeResponse({ body: { embedding: [1] } }))
    await generateOllamaEmbedding("http://localhost:11434/", "m", "x")
    expect(proxyFetch.mock.calls[0][0]).toBe("http://localhost:11434/api/embeddings")
  })

  it("supports the newer embeddings[][] response shape", async () => {
    proxyFetch.mockResolvedValue(makeResponse({ body: { embeddings: [[1, 2, 3]] } }))
    const out = await generateOllamaEmbedding("http://localhost:11434", "m", "hello")
    expect(out).toEqual([1, 2, 3])
  })

  it("throws on a 4xx response with the body included in the message", async () => {
    proxyFetch.mockResolvedValue(
      makeResponse({ status: 404, statusText: "Not Found", rawText: "model not found" })
    )
    await expect(generateOllamaEmbedding("http://localhost:11434", "missing", "x")).rejects.toThrow(
      /HTTP 404/
    )
    await expect(generateOllamaEmbedding("http://localhost:11434", "missing", "x")).rejects.toThrow(
      /model not found/
    )
  })

  it("throws on a 5xx response", async () => {
    proxyFetch.mockResolvedValue(makeResponse({ status: 500, statusText: "Server Error" }))
    await expect(generateOllamaEmbedding("http://localhost:11434", "m", "x")).rejects.toThrow(
      /HTTP 500/
    )
  })

  it("throws when the body is missing the embedding fields", async () => {
    proxyFetch.mockResolvedValue(makeResponse({ body: { not_what_you_expected: true } }))
    await expect(generateOllamaEmbedding("http://localhost:11434", "m", "x")).rejects.toThrow(
      /missing an 'embedding'/
    )
  })

  it("throws when the embedding array is empty", async () => {
    proxyFetch.mockResolvedValue(makeResponse({ body: { embedding: [] } }))
    await expect(generateOllamaEmbedding("http://localhost:11434", "m", "x")).rejects.toThrow(
      /missing an 'embedding'/
    )
  })

  it("throws when JSON parsing fails", async () => {
    proxyFetch.mockResolvedValue(makeResponse({ jsonThrows: true }))
    await expect(generateOllamaEmbedding("http://localhost:11434", "m", "x")).rejects.toThrow(
      /not valid JSON/
    )
  })

  it("propagates fetch-layer errors with context", async () => {
    proxyFetch.mockRejectedValue(new Error("ECONNREFUSED"))
    await expect(generateOllamaEmbedding("http://localhost:11434", "m", "x")).rejects.toThrow(
      /ECONNREFUSED/
    )
    await expect(generateOllamaEmbedding("http://localhost:11434", "m", "x")).rejects.toThrow(
      /url=http:\/\/localhost:11434\/api\/embeddings/
    )
  })

  it("handles non-Error throwables from the fetch layer", async () => {
    proxyFetch.mockRejectedValue("string-thrown-without-Error")
    await expect(generateOllamaEmbedding("http://localhost:11434", "m", "x")).rejects.toThrow(
      /string-thrown-without-Error/
    )
  })

  it("handles non-Error throwables from JSON parsing", async () => {
    proxyFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "",
      json: async () => {
        throw "not-an-error-instance"
      },
      text: async () => "",
    } as unknown as Response)
    await expect(generateOllamaEmbedding("http://localhost:11434", "m", "x")).rejects.toThrow(
      /not-an-error-instance/
    )
  })

  it("throws when baseURL is missing", async () => {
    await expect(generateOllamaEmbedding("", "m", "x")).rejects.toThrow(/baseURL is required/)
  })

  it("throws when modelId is missing", async () => {
    await expect(generateOllamaEmbedding("http://localhost:11434", "", "x")).rejects.toThrow(
      /modelId is required/
    )
  })
})
