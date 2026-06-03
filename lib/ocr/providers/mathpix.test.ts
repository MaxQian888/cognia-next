import { buildMathpixProvider, mathpixExtract } from "./mathpix"
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
    credentials: overrides.credentials ?? { secrets: { appId: "id", appKey: "key" } },
    config: overrides.config ?? {},
    platform: "web",
    signal: overrides.signal,
  }
}

const input: OcrInput = {
  source: { kind: "data-url", dataUrl: "data:image/png;base64,YWJj", mimeType: "image/png" },
  languages: ["en"],
}

describe("buildMathpixProvider", () => {
  it("declares metadata + credential keys", () => {
    const p = buildMathpixProvider()
    expect(p.id).toBe("mathpix")
    expect(p.category).toBe("specialist")
    expect(p.credentialKeys).toEqual(["appId", "appKey"])
  })
})

describe("mathpixExtract", () => {
  it("returns text + LaTeX-stripped plain text", async () => {
    const fetchImpl = makeFetch({
      status: 200,
      body: { text: "Hello $x=1$ world" },
    })
    const result = await mathpixExtract(input, makeCtx(), fetchImpl)
    expect(result.providerId).toBe("mathpix")
    expect(result.pages[0]!.markdown).toContain("$x=1$")
    expect(result.pages[0]!.text).not.toContain("$")
    expect(result.costEstimate?.unit).toBe("image")
  })

  it("attaches app_id and app_key headers", async () => {
    let seen: Headers | undefined
    const fetchImpl = jest.fn(async (_url, init: RequestInit | undefined) => {
      seen = new Headers(init?.headers)
      return new Response(JSON.stringify({ text: "" }), { status: 200 })
    }) as unknown as typeof fetch
    await mathpixExtract(input, makeCtx(), fetchImpl)
    expect(seen?.get("app_id")).toBe("id")
    expect(seen?.get("app_key")).toBe("key")
  })

  it("throws missing_credentials when appKey is missing", async () => {
    const fetchImpl = makeFetch({ status: 200, body: { text: "" } })
    await expect(
      mathpixExtract(input, makeCtx({ credentials: { secrets: { appId: "id" } } }), fetchImpl)
    ).rejects.toMatchObject({ code: "missing_credentials" })
  })

  it("maps an error_info rate-limit message to rate_limited", async () => {
    const fetchImpl = makeFetch({
      status: 200,
      body: { error_info: { message: "rate limit exceeded" } },
    })
    await expect(mathpixExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "rate_limited",
    })
  })

  it("maps unauthorized error_info to missing_credentials", async () => {
    const fetchImpl = makeFetch({
      status: 200,
      body: { error_info: { message: "invalid api key" } },
    })
    await expect(mathpixExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "missing_credentials",
    })
  })

  it("maps generic errors to provider_failed", async () => {
    const fetchImpl = makeFetch({
      status: 200,
      body: { error_info: { message: "something else" } },
    })
    await expect(mathpixExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "provider_failed",
    })
  })
})
