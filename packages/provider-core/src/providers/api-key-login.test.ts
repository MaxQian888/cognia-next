/** @jest-environment jsdom */
import { getAllProviders, setDynamicProviderRegistry } from "@cognia/provider-types"

import {
  getKeyLoginConfig,
  normalizeApiKey,
  resolveKeyLogin,
  supportsKeyLogin,
  validateProviderApiKey,
} from "./api-key-login"

const fetchMock = jest.fn()

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

const provider = (id: string, keyLogin: unknown) =>
  ({ id, name: id, models: [], defaultModel: "m", keyLogin }) as never

beforeAll(() => {
  setDynamicProviderRegistry(() => ({
    "test-models": provider("test-models", {
      authUrl: "https://console.test/keys",
      placeholder: "sk-...",
      normalize: "strip-bearer",
      validate: { kind: "models-endpoint", url: "https://api.test/v1/models" },
    }),
    "test-chat": provider("test-chat", {
      validate: {
        kind: "chat-completions",
        baseUrl: "https://api.test/v1",
        model: "probe-model",
        tolerateModelDenied: true,
      },
    }),
    "test-anthropic": provider("test-anthropic", {
      validate: { kind: "anthropic-messages", baseUrl: "https://api.test/v1", model: "probe" },
    }),
    "test-no-probe": provider("test-no-probe", { authUrl: "https://console.test" }),
  }))
})

afterAll(() => {
  setDynamicProviderRegistry(() => ({}))
})

beforeEach(() => {
  fetchMock.mockReset()
  global.fetch = fetchMock as unknown as typeof fetch
})

describe("getKeyLoginConfig", () => {
  it("returns the spec only for a provider that declares one", () => {
    expect(getKeyLoginConfig("test-models")).toMatchObject({ authUrl: "https://console.test/keys" })
    expect(getKeyLoginConfig("openrouter")).toBeNull()
    expect(supportsKeyLogin("test-models")).toBe(true)
  })
})

describe("normalizeApiKey", () => {
  it("trims, and strips a pasted Authorization header when asked", () => {
    expect(normalizeApiKey("  sk-abc  ")).toBe("sk-abc")
    expect(normalizeApiKey("Bearer sk-abc", "strip-bearer")).toBe("sk-abc")
    expect(normalizeApiKey("bearer   sk-abc", "strip-bearer")).toBe("sk-abc")
    // Without the rule the prefix is part of the key, and removing it silently
    // would corrupt a key that legitimately starts that way.
    expect(normalizeApiKey("Bearer sk-abc")).toBe("Bearer sk-abc")
  })
})

describe("validateProviderApiKey", () => {
  it("passes a key the provider accepts", async () => {
    fetchMock.mockResolvedValueOnce(response({ data: [] }))
    await expect(validateProviderApiKey("test-models", "sk-good")).resolves.toEqual({
      status: "valid",
    })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.test/v1/models")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-good")
  })

  it("rejects a key the provider refuses", async () => {
    fetchMock.mockResolvedValueOnce(response({ error: { message: "invalid api key" } }, 401))
    await expect(validateProviderApiKey("test-models", "sk-bad")).resolves.toEqual({
      status: "invalid",
      message: "invalid api key",
    })
  })

  it("refuses an empty key without asking the provider", async () => {
    await expect(validateProviderApiKey("test-models", "   ")).resolves.toMatchObject({
      status: "invalid",
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("says unverified, not invalid, when the probe could not answer", async () => {
    // Refusing a key because the user is offline would be the wrong answer to
    // a question we never actually asked.
    fetchMock.mockRejectedValueOnce(new Error("offline"))
    await expect(validateProviderApiKey("test-models", "sk-1")).resolves.toMatchObject({
      status: "unverified",
    })

    fetchMock.mockResolvedValueOnce(response({ error: "slow down" }, 429))
    await expect(validateProviderApiKey("test-models", "sk-1")).resolves.toMatchObject({
      status: "unverified",
    })
  })

  it("accepts a key that works but cannot reach the probe model", async () => {
    fetchMock.mockResolvedValueOnce(
      response({ error: { message: "model probe-model not found" } }, 404)
    )
    await expect(validateProviderApiKey("test-chat", "sk-1")).resolves.toEqual({ status: "valid" })
  })

  it("does not convict a key on a forbidden that never mentions the key", async () => {
    // A 403 means the credential authenticated and was then refused this
    // particular thing. Reading that as "bad key" throws away working keys on
    // every provider that gates by plan, region or model, so the pasted key
    // survives and the provider's own words are what the user sees.
    fetchMock.mockResolvedValueOnce(response({ error: { message: "account disabled" } }, 403))
    await expect(validateProviderApiKey("test-chat", "sk-1")).resolves.toMatchObject({
      status: "unverified",
      message: "account disabled",
    })
  })

  it("convicts a forbidden that names the credential as the problem", async () => {
    fetchMock.mockResolvedValueOnce(response({ error: { message: "API key expired" } }, 403))
    await expect(validateProviderApiKey("test-chat", "sk-1")).resolves.toMatchObject({
      status: "invalid",
    })
  })

  it("convicts a Chinese-language rejection of the key", async () => {
    // The relays this matters most for answer in Chinese, and a verdict that
    // only reads English would let a plainly rejected key through as a shrug.
    fetchMock.mockResolvedValueOnce(response({ error: { message: "API 密钥无效" } }, 400))
    await expect(validateProviderApiKey("test-chat", "sk-1")).resolves.toMatchObject({
      status: "invalid",
    })
  })

  it("keeps a model-access refusal out of the credential verdict", async () => {
    fetchMock.mockResolvedValueOnce(
      response({ error: { message: "your API key cannot access this model" } }, 403)
    )
    await expect(validateProviderApiKey("test-anthropic", "sk-1")).resolves.toMatchObject({
      status: "unverified",
    })
  })

  it("sends a one-token completion for the chat probe", async () => {
    fetchMock.mockResolvedValueOnce(response({ choices: [] }))
    await validateProviderApiKey("test-chat", "sk-1")
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.test/v1/chat/completions")
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "probe-model", max_tokens: 1 })
  })

  it("uses Anthropic's own auth header for the anthropic probe", async () => {
    fetchMock.mockResolvedValueOnce(response({ content: [] }))
    await validateProviderApiKey("test-anthropic", "sk-ant")
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.test/v1/messages")
    const headers = init.headers as Record<string, string>
    expect(headers["x-api-key"]).toBe("sk-ant")
    expect(headers["anthropic-version"]).toBe("2023-06-01")
  })

  it("is unverified for a provider that declares no probe", async () => {
    // Reporting "valid" without having asked anyone would be a guess dressed
    // up as a check.
    await expect(validateProviderApiKey("test-no-probe", "sk-1")).resolves.toMatchObject({
      status: "unverified",
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("resolveKeyLogin", () => {
  it("derives the console page and a token-free probe from the catalog", async () => {
    // Nothing was hand-written for Moonshot: `dashboardUrl` is already the page
    // where a key is minted, and `defaultBaseURL` already says where to ask.
    const resolved = resolveKeyLogin("moonshot")
    expect(resolved?.authUrl).toBe("https://platform.moonshot.cn/console/api-keys")
    expect(resolved?.validate).toEqual({
      kind: "models-endpoint",
      url: "https://api.moonshot.cn/v1/models",
      auth: "bearer",
    })
  })

  it("sends an Anthropic-protocol provider its own auth header", async () => {
    fetchMock.mockResolvedValueOnce(response({ data: [] }))
    await validateProviderApiKey("anthropic", "sk-ant-1")
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers["x-api-key"]).toBe("sk-ant-1")
    expect(headers.Authorization).toBeUndefined()
  })

  it("gives the first-party majors a probe their SDK-defaulted base URL cannot derive", () => {
    // openai / anthropic / google let their SDKs default the base URL, so the
    // catalog has nothing to build a probe from and they would otherwise be
    // the only providers left without one.
    for (const id of ["openai", "anthropic", "google", "mistral"]) {
      expect(resolveKeyLogin(id)?.validate).toMatchObject({ kind: "models-endpoint" })
    }
  })

  it("lets an explicit declaration win over the derived probe", () => {
    expect(resolveKeyLogin("test-chat")?.validate).toMatchObject({ kind: "chat-completions" })
    expect(resolveKeyLogin("test-models")?.authUrl).toBe("https://console.test/keys")
  })

  it("covers most of the catalog, not just the entries someone wrote by hand", () => {
    // The value here is breadth. If this ever collapses to a handful, the
    // derivation has been broken and most providers are back to a bare box.
    const ids = Object.keys(getAllProviders())
    const covered = ids.filter((id) => supportsKeyLogin(id))
    expect(covered.length).toBeGreaterThan(30)
  })

  it("sends a relay entry to the console of the vendor it is a deployment of", () => {
    // A coding plan is billed to the vendor's account and opened with the
    // vendor's key, so the vendor's key page is the answer rather than a
    // guess. Before this, every one of these rendered a Verify button above a
    // key box that never said where the key comes from.
    const zhipu = getAllProviders().zhipu
    expect(resolveKeyLogin("glm-anthropic")).toMatchObject({
      authUrl: zhipu?.dashboardUrl,
      authUrlSource: "relay",
    })
    expect(resolveKeyLogin("kimi-anthropic")).toMatchObject({ authUrlSource: "relay" })
    expect(resolveKeyLogin("qianfan-coding")?.authUrl).toBeTruthy()
  })

  it("prefers a provider's own console over the vendor it relays", () => {
    const own = resolveKeyLogin("openrouter")
    expect(own).toMatchObject({ authUrlSource: "dashboard" })
    expect(own?.authUrl).toBe(getAllProviders().openrouter?.dashboardUrl)
  })

  it("falls back to the vendor's platform page when no console is declared anywhere", () => {
    // `packycode` names no console and relays no vendor that has one. Its
    // platform page is a weaker answer than a key page, never a wrong one.
    expect(resolveKeyLogin("packycode")).toMatchObject({
      authUrl: getAllProviders().packycode?.website,
      authUrlSource: "website",
    })
  })

  it("leaves no key-requiring provider without somewhere to get a key", () => {
    const orphans = Object.values(getAllProviders())
      .filter((entry) => !entry.id.startsWith("test-"))
      .filter((entry) => entry.apiKeyRequired !== false)
      .filter((entry) => !resolveKeyLogin(entry.id)?.authUrl)
      .map((entry) => entry.id)
    expect(orphans).toEqual([])
  })

  it("declines providers that need no key at all", () => {
    // A local runtime has nothing to log in to.
    expect(resolveKeyLogin("ollama")).toBeNull()
  })
})

describe("the fallback probe", () => {
  it("asks again in the shape a relay implements when /models is not there", async () => {
    // The Chinese coding plans borrow Anthropic's wire but ship only
    // /messages, so the free probe 404s. Without the second ask, Verify can
    // never reach a verdict for this entire family of providers.
    fetchMock
      .mockResolvedValueOnce(response({ error: { message: "not found" } }, 404))
      .mockResolvedValueOnce(response({ content: [] }, 200))

    await expect(validateProviderApiKey("glm-anthropic", "sk-1")).resolves.toMatchObject({
      status: "valid",
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toContain("/models")
    expect(fetchMock.mock.calls[1][0]).toContain("/messages")
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "POST" })
  })

  it("does not spend a token when the first probe already answered", async () => {
    fetchMock.mockResolvedValueOnce(response({ error: { message: "invalid api key" } }, 401))

    await expect(validateProviderApiKey("glm-anthropic", "sk-1")).resolves.toMatchObject({
      status: "invalid",
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("is not offered for a provider whose own probe shape is declared", () => {
    // A declared probe is the provider's own word on how to check a key.
    // Second-guessing it with a derived retry would spend tokens to contradict
    // the only authority there is.
    expect(resolveKeyLogin("test-anthropic")?.fallbackValidate).toBeUndefined()
  })

  it("is not offered to providers that do not speak the Anthropic wire", () => {
    expect(resolveKeyLogin("deepseek")?.fallbackValidate).toBeUndefined()
  })
})
