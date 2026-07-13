import { buildOpenAiVisionProvider, openAiVisionExtract } from "./openai-vision"
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

describe("buildOpenAiVisionProvider", () => {
  it("declares vision metadata and the main-key reuse flag", () => {
    const p = buildOpenAiVisionProvider()
    expect(p.id).toBe("openai-vision")
    expect(p.category).toBe("llm-vision")
    expect(p.reusesMainProviderKey).toBe(true)
    expect(p.credentialKeys).toEqual([])
  })
})

describe("openAiVisionExtract — success", () => {
  it("returns Markdown from choices[0].message.content", async () => {
    const fetchImpl = makeFetch({
      status: 200,
      body: {
        choices: [{ message: { content: "# Hello\nbody" } }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      },
    })
    const result = await openAiVisionExtract(input, makeCtx(), fetchImpl)
    expect(result.pages[0]!.markdown).toContain("# Hello")
    expect(result.costEstimate?.unit).toBe("token")
  })

  it("sends max_completion_tokens (never the legacy max_tokens) and the default model", async () => {
    let seenBody: Record<string, unknown> = {}
    const fetchImpl = jest.fn(async (_url, init: RequestInit | undefined) => {
      seenBody = JSON.parse(init?.body as string)
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
      })
    }) as unknown as typeof fetch
    await openAiVisionExtract(input, makeCtx(), fetchImpl)
    expect(seenBody.max_completion_tokens).toBe(4096)
    expect(seenBody).not.toHaveProperty("max_tokens")
    expect(seenBody.model).toBe("gpt-5.6")
  })

  it("attaches the bearer Authorization header", async () => {
    let seen: Headers | undefined
    const fetchImpl = jest.fn(async (_url, init: RequestInit | undefined) => {
      seen = new Headers(init?.headers)
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
      })
    }) as unknown as typeof fetch
    await openAiVisionExtract(input, makeCtx(), fetchImpl)
    expect(seen?.get("authorization")).toBe("Bearer sk-test")
  })

  it("attaches OpenAI-Organization when configured", async () => {
    let seen: Headers | undefined
    const fetchImpl = jest.fn(async (_url, init: RequestInit | undefined) => {
      seen = new Headers(init?.headers)
      return new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), {
        status: 200,
      })
    }) as unknown as typeof fetch
    await openAiVisionExtract(input, makeCtx({ config: { organization: "org_x" } }), fetchImpl)
    expect(seen?.get("openai-organization")).toBe("org_x")
  })

  it("falls back to getMainProviderKey when secrets are empty", async () => {
    const getMainProviderKey = jest.fn(async () => "from-main")
    const ctx: OcrProviderContext = {
      credentials: { secrets: {}, getMainProviderKey },
      config: {},
      platform: "web",
    }
    const fetchImpl = makeFetch({
      status: 200,
      body: { choices: [{ message: { content: "" } }] },
    })
    await openAiVisionExtract(input, ctx, fetchImpl)
    expect(getMainProviderKey).toHaveBeenCalledWith("openai")
  })
})

describe("openAiVisionExtract — error paths", () => {
  it("throws missing_credentials when no key resolves", async () => {
    const fetchImpl = makeFetch({ status: 200, body: { choices: [] } })
    await expect(
      openAiVisionExtract(input, makeCtx({ credentials: { secrets: {} } }), fetchImpl)
    ).rejects.toMatchObject({ code: "missing_credentials" })
  })

  it("maps rate_limit_exceeded body to rate_limited", async () => {
    const fetchImpl = makeFetch({
      status: 200,
      body: { error: { code: "rate_limit_exceeded", message: "slow" } },
    })
    await expect(openAiVisionExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "rate_limited",
    })
  })

  it("maps invalid_request_error to invalid_input", async () => {
    const fetchImpl = makeFetch({
      status: 200,
      body: { error: { type: "invalid_request_error", message: "bad" } },
    })
    await expect(openAiVisionExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "invalid_input",
    })
  })

  it("maps authentication_error to missing_credentials", async () => {
    const fetchImpl = makeFetch({
      status: 200,
      body: { error: { type: "authentication_error", message: "no" } },
    })
    await expect(openAiVisionExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "missing_credentials",
    })
  })

  it("maps a server-side error to provider_failed", async () => {
    const fetchImpl = makeFetch({
      status: 200,
      body: { error: { type: "server_error", message: "boom" } },
    })
    await expect(openAiVisionExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "provider_failed",
    })
  })
})
