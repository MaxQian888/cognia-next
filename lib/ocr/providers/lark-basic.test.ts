import { __clearLarkTokenCache, buildLarkBasicProvider, larkBasicExtract } from "./lark-basic"
import type { OcrInput, OcrProviderContext } from "@/types/ocr"

interface FetchResponseSpec {
  status: number
  body: unknown
  headers?: Record<string, string>
}

function makeFetchSequence(responses: FetchResponseSpec[]) {
  let i = 0
  return jest.fn(async () => {
    const resp = responses[i++] ?? responses[responses.length - 1]!
    return new Response(typeof resp.body === "string" ? resp.body : JSON.stringify(resp.body), {
      status: resp.status,
      headers: resp.headers,
    })
  }) as unknown as typeof fetch
}

function makeCtx(overrides: Partial<OcrProviderContext> = {}): OcrProviderContext {
  return {
    credentials: overrides.credentials ?? { secrets: { appId: "app", appSecret: "secret" } },
    config: overrides.config ?? { now: () => 1_700_000_000_000 },
    platform: "web",
    signal: overrides.signal,
  }
}

const input: OcrInput = {
  source: { kind: "data-url", dataUrl: "data:image/png;base64,YWJj", mimeType: "image/png" },
  languages: ["zh"],
}

beforeEach(() => __clearLarkTokenCache())

describe("buildLarkBasicProvider", () => {
  it("declares metadata + credential keys", () => {
    const p = buildLarkBasicProvider()
    expect(p.id).toBe("lark-basic")
    expect(p.category).toBe("lark")
    expect(p.credentialKeys).toEqual(["appId", "appSecret"])
  })
})

describe("larkBasicExtract — success", () => {
  it("fetches a tenant_access_token, then performs OCR", async () => {
    const fetchImpl = makeFetchSequence([
      { status: 200, body: { code: 0, msg: "ok", tenant_access_token: "tat-1", expire: 7200 } },
      { status: 200, body: { code: 0, msg: "ok", data: { text_list: ["你好", "世界"] } } },
    ])
    const result = await larkBasicExtract(input, makeCtx(), fetchImpl)
    expect(result.providerId).toBe("lark-basic")
    expect(result.pages[0]!.text).toBe("你好\n世界")
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("reuses a cached token across calls", async () => {
    const fetchImpl = makeFetchSequence([
      { status: 200, body: { code: 0, tenant_access_token: "tat-1", expire: 7200 } },
      { status: 200, body: { code: 0, data: { text_list: ["a"] } } },
      // Second OCR call: no token refresh — only one fetch should happen here.
      { status: 200, body: { code: 0, data: { text_list: ["b"] } } },
    ])
    await larkBasicExtract(input, makeCtx(), fetchImpl)
    await larkBasicExtract(input, makeCtx(), fetchImpl)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it("refreshes the token when it is near expiry", async () => {
    let now = 1_700_000_000_000
    const ctx = makeCtx({ config: { now: () => now } })
    const fetchImpl = makeFetchSequence([
      { status: 200, body: { code: 0, tenant_access_token: "tat-1", expire: 120 } },
      { status: 200, body: { code: 0, data: { text_list: ["a"] } } },
      // After advancing clock by 90s the cached token's remaining time (30s)
      // is inside the 2-minute safety window, so a new fetch is required.
      { status: 200, body: { code: 0, tenant_access_token: "tat-2", expire: 120 } },
      { status: 200, body: { code: 0, data: { text_list: ["b"] } } },
    ])
    await larkBasicExtract(input, ctx, fetchImpl)
    now += 90 * 1000
    await larkBasicExtract(input, ctx, fetchImpl)
    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })
})

describe("larkBasicExtract — error paths", () => {
  it("throws missing_credentials when no appId is set", async () => {
    const fetchImpl = makeFetchSequence([{ status: 200, body: {} }])
    await expect(
      larkBasicExtract(input, makeCtx({ credentials: { secrets: {} } }), fetchImpl)
    ).rejects.toMatchObject({ code: "missing_credentials" })
  })

  it("throws missing_credentials when token issuance returns code=99991663", async () => {
    const fetchImpl = makeFetchSequence([
      { status: 200, body: { code: 99991663, msg: "invalid app_secret" } },
    ])
    await expect(larkBasicExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "missing_credentials",
    })
  })

  it("maps OCR code=99991400 (request trigger frequency limit) to rate_limited", async () => {
    const fetchImpl = makeFetchSequence([
      { status: 200, body: { code: 0, tenant_access_token: "tat-1", expire: 7200 } },
      { status: 200, body: { code: 99991400, msg: "request trigger frequency limit" } },
    ])
    await expect(larkBasicExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "rate_limited",
    })
  })

  it("maps an unknown non-zero code to provider_failed", async () => {
    const fetchImpl = makeFetchSequence([
      { status: 200, body: { code: 0, tenant_access_token: "tat-1", expire: 7200 } },
      { status: 200, body: { code: 9999, msg: "weird" } },
    ])
    await expect(larkBasicExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "provider_failed",
    })
  })

  it("throws when token response lacks tenant_access_token", async () => {
    const fetchImpl = makeFetchSequence([{ status: 200, body: { code: 0 } }])
    await expect(larkBasicExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "provider_failed",
    })
  })
})
