import { anthropicVisionExtract, buildAnthropicVisionProvider } from "./anthropic-vision"
import type { OcrInput, OcrProviderContext } from "@/types/ocr"

function makeFetch(resp: { status: number; body: unknown }) {
  return jest.fn(async () => {
    return new Response(typeof resp.body === "string" ? resp.body : JSON.stringify(resp.body), {
      status: resp.status,
    })
  }) as unknown as typeof fetch
}

function makeCtx(overrides: Partial<OcrProviderContext> = {}): OcrProviderContext {
  return {
    credentials: overrides.credentials ?? { secrets: { apiKey: "sk-test" } },
    config: overrides.config ?? {},
    platform: overrides.platform ?? "web",
    signal: overrides.signal,
  }
}

const input: OcrInput = {
  source: { kind: "data-url", dataUrl: "data:image/png;base64,YWJj", mimeType: "image/png" },
  languages: ["en"],
}

describe("buildAnthropicVisionProvider", () => {
  it("declares vision metadata and the main-key reuse flag", () => {
    const p = buildAnthropicVisionProvider()
    expect(p.id).toBe("anthropic-vision")
    expect(p.category).toBe("llm-vision")
    expect(p.reusesMainProviderKey).toBe(true)
    expect(p.credentialKeys).toEqual([])
  })
})

describe("anthropicVisionExtract — success", () => {
  it("returns assistant Markdown joined from text blocks", async () => {
    const fetchImpl = makeFetch({
      status: 200,
      body: {
        content: [
          { type: "text", text: "# Hello" },
          { type: "text", text: "world" },
        ],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    })
    const result = await anthropicVisionExtract(input, makeCtx(), fetchImpl)
    expect(result.providerId).toBe("anthropic-vision")
    expect(result.pages[0]!.markdown).toContain("# Hello")
    expect(result.pages[0]!.markdown).toContain("world")
    expect(result.costEstimate?.unit).toBe("token")
    expect(result.costEstimate?.amount).toBeGreaterThan(0)
  })

  it("sends x-api-key header and the anthropic-version header", async () => {
    let seen: Headers | undefined
    const fetchImpl = jest.fn(async (_url, init: RequestInit | undefined) => {
      seen = new Headers(init?.headers)
      return new Response(JSON.stringify({ content: [] }), { status: 200 })
    }) as unknown as typeof fetch
    await anthropicVisionExtract(input, makeCtx(), fetchImpl)
    expect(seen?.get("x-api-key")).toBe("sk-test")
    expect(seen?.get("anthropic-version")).toBe("2023-06-01")
  })

  it("falls back to getMainProviderKey when secrets are empty", async () => {
    const getMainProviderKey = jest.fn(async () => "from-main")
    const ctx: OcrProviderContext = {
      credentials: { secrets: {}, getMainProviderKey },
      config: {},
      platform: "web",
    }
    const fetchImpl = makeFetch({ status: 200, body: { content: [] } })
    await anthropicVisionExtract(input, ctx, fetchImpl)
    expect(getMainProviderKey).toHaveBeenCalledWith("anthropic")
  })
})

describe("anthropicVisionExtract — error paths", () => {
  it("throws missing_credentials when no key is available", async () => {
    const fetchImpl = makeFetch({ status: 200, body: { content: [] } })
    await expect(
      anthropicVisionExtract(input, makeCtx({ credentials: { secrets: {} } }), fetchImpl)
    ).rejects.toMatchObject({ code: "missing_credentials" })
  })

  it("maps rate_limit_error body to rate_limited", async () => {
    const fetchImpl = makeFetch({
      status: 200,
      body: { error: { type: "rate_limit_error", message: "slow down" } },
    })
    await expect(anthropicVisionExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "rate_limited",
    })
  })

  it("maps authentication_error to missing_credentials", async () => {
    const fetchImpl = makeFetch({
      status: 200,
      body: { error: { type: "authentication_error", message: "no" } },
    })
    await expect(anthropicVisionExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "missing_credentials",
    })
  })

  it("maps unknown error type to provider_failed", async () => {
    const fetchImpl = makeFetch({
      status: 200,
      body: { error: { type: "overloaded_error", message: "later" } },
    })
    await expect(anthropicVisionExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "provider_failed",
    })
  })

  it("maps HTTP 401 to missing_credentials", async () => {
    const fetchImpl = makeFetch({ status: 401, body: "unauthorized" })
    await expect(anthropicVisionExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "missing_credentials",
    })
  })
})
