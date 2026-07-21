import { buildGeminiVisionProvider, geminiVisionExtract } from "./gemini-vision"
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
    credentials: overrides.credentials ?? { secrets: { apiKey: "gem-test" } },
    config: overrides.config ?? {},
    platform: overrides.platform ?? "web",
    signal: overrides.signal,
  }
}

const input: OcrInput = {
  source: { kind: "data-url", dataUrl: "data:image/png;base64,YWJj", mimeType: "image/png" },
  languages: ["en"],
}

describe("buildGeminiVisionProvider", () => {
  it("declares vision metadata + main-key reuse", () => {
    const p = buildGeminiVisionProvider()
    expect(p.id).toBe("gemini-vision")
    expect(p.category).toBe("llm-vision")
    expect(p.reusesMainProviderKey).toBe(true)
    expect(p.credentialKeys).toEqual([])
  })
})

describe("geminiVisionExtract — success", () => {
  it("returns Markdown joined from candidate parts", async () => {
    const fetchImpl = makeFetch({
      status: 200,
      body: {
        candidates: [{ content: { parts: [{ text: "# Hello" }, { text: "\nworld" }] } }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
      },
    })
    const result = await geminiVisionExtract(input, makeCtx(), fetchImpl)
    expect(result.pages[0]!.markdown).toContain("# Hello")
    expect(result.pages[0]!.markdown).toContain("world")
    expect(result.costEstimate?.unit).toBe("token")
  })

  it("forwards the API key as the ?key= query parameter", async () => {
    let seenUrl = ""
    const fetchImpl = jest.fn(async (url: RequestInfo | URL) => {
      seenUrl = typeof url === "string" ? url : url.toString()
      return new Response(JSON.stringify({ candidates: [] }), { status: 200 })
    }) as unknown as typeof fetch
    await geminiVisionExtract(input, makeCtx(), fetchImpl)
    expect(seenUrl).toContain("?key=gem-test")
  })

  it("defaults to the GA gemini-3.5-flash model in the endpoint path", async () => {
    let seenUrl = ""
    const fetchImpl = jest.fn(async (url: RequestInfo | URL) => {
      seenUrl = typeof url === "string" ? url : url.toString()
      return new Response(JSON.stringify({ candidates: [] }), { status: 200 })
    }) as unknown as typeof fetch
    await geminiVisionExtract(input, makeCtx(), fetchImpl)
    expect(seenUrl).toContain("/models/gemini-3.5-flash:generateContent")
  })

  it("warns but still returns partial text when finishReason is MAX_TOKENS", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const fetchImpl = makeFetch({
        status: 200,
        body: {
          candidates: [
            { content: { parts: [{ text: "partial transcript" }] }, finishReason: "MAX_TOKENS" },
          ],
        },
      })
      const result = await geminiVisionExtract(input, makeCtx(), fetchImpl)
      expect(result.pages[0]!.markdown).toBe("partial transcript")
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("truncated"))
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("does not warn when finishReason is STOP", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const fetchImpl = makeFetch({
        status: 200,
        body: { candidates: [{ content: { parts: [{ text: "full" }] }, finishReason: "STOP" }] },
      })
      const result = await geminiVisionExtract(input, makeCtx(), fetchImpl)
      expect(result.pages[0]!.markdown).toBe("full")
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("falls back to getMainProviderKey('gemini')", async () => {
    const getMainProviderKey = jest.fn(async (id: string) => (id === "gemini" ? "from-main" : null))
    const ctx: OcrProviderContext = {
      credentials: { secrets: {}, getMainProviderKey },
      config: {},
      platform: "web",
    }
    const fetchImpl = makeFetch({ status: 200, body: { candidates: [] } })
    await geminiVisionExtract(input, ctx, fetchImpl)
    expect(getMainProviderKey).toHaveBeenCalledWith("gemini")
  })

  it("falls through to getMainProviderKey('google') when gemini key is missing", async () => {
    const getMainProviderKey = jest.fn(async (id: string) =>
      id === "google" ? "from-google" : null
    )
    const ctx: OcrProviderContext = {
      credentials: { secrets: {}, getMainProviderKey },
      config: {},
      platform: "web",
    }
    const fetchImpl = makeFetch({ status: 200, body: { candidates: [] } })
    await geminiVisionExtract(input, ctx, fetchImpl)
    expect(getMainProviderKey).toHaveBeenCalledWith("google")
  })
})

describe("geminiVisionExtract — error paths", () => {
  it("throws missing_credentials when no key resolves", async () => {
    const fetchImpl = makeFetch({ status: 200, body: { candidates: [] } })
    await expect(
      geminiVisionExtract(input, makeCtx({ credentials: { secrets: {} } }), fetchImpl)
    ).rejects.toMatchObject({ code: "missing_credentials" })
  })

  it("maps code=429 / RESOURCE_EXHAUSTED to rate_limited", async () => {
    const fetchImpl = makeFetch({
      status: 200,
      body: { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "slow" } },
    })
    await expect(geminiVisionExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "rate_limited",
    })
  })

  it("maps INVALID_ARGUMENT to invalid_input", async () => {
    const fetchImpl = makeFetch({
      status: 200,
      body: { error: { code: 400, status: "INVALID_ARGUMENT", message: "bad" } },
    })
    await expect(geminiVisionExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "invalid_input",
    })
  })

  it("maps UNAUTHENTICATED to missing_credentials", async () => {
    const fetchImpl = makeFetch({
      status: 200,
      body: { error: { code: 401, status: "UNAUTHENTICATED", message: "no key" } },
    })
    await expect(geminiVisionExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "missing_credentials",
    })
  })

  it("maps generic Gemini errors to provider_failed", async () => {
    const fetchImpl = makeFetch({
      status: 200,
      body: { error: { code: 500, status: "INTERNAL", message: "boom" } },
    })
    await expect(geminiVisionExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "provider_failed",
    })
  })
})
