import type { DecisionRequest, DecisionSettings } from "@/types/decisions"
import { BUILTIN_HTTP_PROVIDER_ID, createDecisionsHttpProvider } from "./decisions-http"

const request: DecisionRequest = {
  state: { post: "hello" },
  questions: { spam: { type: "noul", instructions: "Is `post` spam?" } },
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status })
}

function setup(
  options: {
    settings?: DecisionSettings
    key?: string | null
    fetch?: jest.Mock
    reachesNonCorsHosts?: boolean
    timeoutMs?: number
  } = {}
) {
  const fetch =
    options.fetch ?? jest.fn(async () => jsonResponse({ answers: { spam: { noul: 0.1 } } }))
  const provider = createDecisionsHttpProvider({
    loadSettings: async () => options.settings ?? { http: { preset: "openrouter" } },
    getKey: async () => (options.key === undefined ? "sk-test" : options.key),
    fetch,
    reachesNonCorsHosts: () => options.reachesNonCorsHosts ?? true,
    timeoutMs: options.timeoutMs ?? 1000,
  })
  return { provider, fetch }
}

describe("createDecisionsHttpProvider", () => {
  it("is the built-in remote provider", () => {
    const { provider } = setup()
    expect(provider).toMatchObject({
      id: BUILTIN_HTTP_PROVIDER_ID,
      locality: "remote",
      calibrated: true,
    })
    expect(provider.pluginId).toBeUndefined()
  })

  it("posts the TypeSafe decisions body with bearer + OpenRouter attribution", async () => {
    const { provider, fetch } = setup()
    const out = await provider.decide(request)
    expect(out).toMatchObject({
      ok: true,
      answers: { spam: { noul: 0.1 } },
      routing: { model: "typesafe/jev-1.13" },
    })
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe("https://openrouter.ai/api/alpha/decisions")
    expect(JSON.parse(init.body)).toEqual({
      model: "typesafe/jev-1.13",
      state: request.state,
      questions: request.questions,
    })
    expect(init.headers).toMatchObject({
      authorization: "Bearer sk-test",
      "content-type": "application/json",
      "X-Title": "Cognia",
    })
  })

  it("sends no attribution headers to systemone gateways", async () => {
    const { provider, fetch } = setup({ settings: { http: { preset: "bocha" } } })
    await provider.decide(request)
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe("https://jev.bocha.cn/v1/systemone")
    expect(init.headers).not.toHaveProperty("X-Title")
  })

  it("reports missing configuration without calling out", async () => {
    const noPreset = setup({ settings: {} })
    await expect(noPreset.provider.decide(request)).resolves.toMatchObject({
      ok: false,
      error: { kind: "not_configured" },
    })
    const noKey = setup({ key: null })
    await expect(noKey.provider.decide(request)).resolves.toMatchObject({
      ok: false,
      error: { kind: "not_configured", message: expect.stringContaining("API key") },
    })
    expect(noPreset.fetch).not.toHaveBeenCalled()
    expect(noKey.fetch).not.toHaveBeenCalled()
  })

  it("maps HTTP errors with status and a capped body, never the key", async () => {
    const { provider } = setup({
      fetch: jest.fn(async () => jsonResponse("x".repeat(1000), 401)),
    })
    const out = await provider.decide(request)
    expect(out).toMatchObject({ ok: false, error: { kind: "http_status", status: 401 } })
    if (!out.ok) {
      expect(out.error.message.length).toBeLessThan(400)
      expect(out.error.message).not.toContain("sk-test")
    }
  })

  it("rejects non-JSON and answer-less replies", async () => {
    const html = setup({ fetch: jest.fn(async () => jsonResponse("<html>")) })
    await expect(html.provider.decide(request)).resolves.toMatchObject({
      error: { kind: "provider_error" },
    })
    const empty = setup({ fetch: jest.fn(async () => jsonResponse({ result: 1 })) })
    await expect(empty.provider.decide(request)).resolves.toMatchObject({
      error: { kind: "provider_error" },
    })
  })

  it("classifies transport failures by shell", async () => {
    const failing = jest.fn(async () => {
      throw new TypeError("Failed to fetch")
    })
    const desktop = setup({ fetch: failing })
    await expect(desktop.provider.decide(request)).resolves.toMatchObject({
      error: { kind: "network" },
    })
    const browser = setup({ fetch: failing, reachesNonCorsHosts: false })
    await expect(browser.provider.decide(request)).resolves.toMatchObject({
      error: { kind: "cors_unreachable" },
    })
  })

  it("times out even when the transport ignores the signal", async () => {
    const { provider } = setup({
      fetch: jest.fn(() => new Promise<Response>(() => {})),
      timeoutMs: 20,
    })
    await expect(provider.decide(request)).resolves.toMatchObject({ error: { kind: "timeout" } })
  })

  it("honors the caller's abort signal", async () => {
    const { provider } = setup({ fetch: jest.fn(() => new Promise<Response>(() => {})) })
    const controller = new AbortController()
    const pending = provider.decide(request, { signal: controller.signal })
    controller.abort()
    await expect(pending).resolves.toMatchObject({ error: { kind: "aborted" } })
    const already = new AbortController()
    already.abort()
    await expect(provider.decide(request, { signal: already.signal })).resolves.toMatchObject({
      error: { kind: "aborted" },
    })
  })

  it("reports readiness from settings + keyring", async () => {
    await expect(setup().provider.status?.()).resolves.toEqual({ ready: true })
    await expect(setup({ key: null }).provider.status?.()).resolves.toMatchObject({ ready: false })
    await expect(
      setup({ settings: { http: { preset: "custom" } } }).provider.status?.()
    ).resolves.toMatchObject({ ready: false, message: expect.stringContaining("URL") })
  })
})
