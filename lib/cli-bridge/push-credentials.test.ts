import { buildCredentialsFile, gatherCredentials, pushCredentialsToCli } from "./push-credentials"
import type { AppSettings } from "@cognia/agent-config-types"

const isTauriMock = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))

const getActiveAccount = jest.fn()
const getAccount = jest.fn()
jest.mock("@/lib/subscription/core/transport", () => ({
  getActiveAccount: (...a: unknown[]) => getActiveAccount(...a),
  getAccount: (...a: unknown[]) => getAccount(...a),
}))

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(true)
})

type ProviderSettings = NonNullable<AppSettings["providerSettings"]>

function ps(map: Record<string, { apiKey?: string }>): ProviderSettings {
  const out: ProviderSettings = {}
  for (const [id, v] of Object.entries(map)) {
    out[id] = { providerId: id, defaultModel: "m", enabled: true, ...v }
  }
  return out
}

describe("buildCredentialsFile", () => {
  it("trims secrets and drops providers with nothing usable", () => {
    const file = buildCredentialsFile({
      anthropic: { apiKey: "  sk-ant  ", authToken: "tok" },
      openai: { apiKey: "   " },
      empty: {},
    })
    expect(file).toEqual({
      providers: { anthropic: { apiKey: "sk-ant", authToken: "tok" } },
    })
  })

  it("returns null when no provider has a secret", () => {
    expect(buildCredentialsFile({ openai: { apiKey: " " } })).toBeNull()
    expect(buildCredentialsFile({})).toBeNull()
  })
})

describe("gatherCredentials", () => {
  it("collects provider apiKeys and the Anthropic subscription bearer", async () => {
    const secrets = await gatherCredentials(
      { providerSettings: ps({ openai: { apiKey: "sk-oai" }, anthropic: {} }) },
      { readAnthropicAuthToken: async () => "bearer-123" }
    )
    expect(secrets.openai).toEqual({ apiKey: "sk-oai" })
    expect(secrets.anthropic).toEqual({ authToken: "bearer-123" })
  })

  it("merges an Anthropic apiKey with its subscription bearer", async () => {
    const secrets = await gatherCredentials(
      { providerSettings: ps({ anthropic: { apiKey: "sk-ant" } }) },
      { readAnthropicAuthToken: async () => "bearer" }
    )
    expect(secrets.anthropic).toEqual({ apiKey: "sk-ant", authToken: "bearer" })
  })

  it("omits the bearer when none is available", async () => {
    const secrets = await gatherCredentials(
      { providerSettings: ps({ openai: { apiKey: "sk-oai" } }) },
      { readAnthropicAuthToken: async () => null }
    )
    expect(secrets.anthropic).toBeUndefined()
  })

  it("uses an API-key Codex vault credential when provider settings have none", async () => {
    const secrets = await gatherCredentials(
      { providerSettings: ps({}) },
      {
        readAnthropicAuthToken: async () => null,
        readCodexVaultCredential: async () => ({
          apiKey: "  sk-codex-vault  ",
          baseURL: "https://api.openai.com/v1",
        }),
      }
    )
    expect(secrets.codex).toEqual({ apiKey: "sk-codex-vault" })
  })

  it("does not serialize ChatGPT-login Codex credentials", async () => {
    const secrets = await gatherCredentials(
      { providerSettings: ps({}) },
      {
        readAnthropicAuthToken: async () => null,
        readCodexVaultCredential: async () => ({
          apiKey: "chatgpt-access-token",
          baseURL: "https://chatgpt.com/backend-api/codex",
          headers: { "ChatGPT-Account-Id": "acct-1" },
        }),
      }
    )
    expect(secrets.codex).toBeUndefined()
  })

  it("keeps the configured Codex API key without probing the vault", async () => {
    const readCodexVaultCredential = jest.fn()
    const secrets = await gatherCredentials(
      { providerSettings: ps({ codex: { apiKey: "sk-settings" } }) },
      { readAnthropicAuthToken: async () => null, readCodexVaultCredential }
    )
    expect(secrets.codex).toEqual({ apiKey: "sk-settings" })
    expect(readCodexVaultCredential).not.toHaveBeenCalled()
  })
})

describe("pushCredentialsToCli", () => {
  it("writes a 0600 credentials.json and returns the provider count", async () => {
    const write = jest.fn(async (_fileName: string, _content: string, _secret: boolean) => {})
    const count = await pushCredentialsToCli(
      { providerSettings: ps({ openai: { apiKey: "sk-oai" } }) },
      { readAnthropicAuthToken: async () => "bearer", write }
    )
    expect(count).toBe(2)
    const [fileName, content, secret] = write.mock.calls[0]
    expect(fileName).toBe("credentials.json")
    expect(secret).toBe(true)
    const parsed = JSON.parse(content)
    expect(parsed.providers.openai).toEqual({ apiKey: "sk-oai" })
    expect(parsed.providers.anthropic).toEqual({ authToken: "bearer" })
  })

  it("returns 0 and does not write when there are no secrets", async () => {
    const write = jest.fn(async () => {})
    const count = await pushCredentialsToCli(
      { providerSettings: ps({}) },
      { readAnthropicAuthToken: async () => null, write }
    )
    expect(count).toBe(0)
    expect(write).not.toHaveBeenCalled()
  })
})

describe("default Anthropic bearer reader (no injected reader)", () => {
  it("returns null off the Tauri desktop", async () => {
    isTauriMock.mockReturnValue(false)
    const secrets = await gatherCredentials({ providerSettings: ps({}) })
    expect(secrets.anthropic).toBeUndefined()
    expect(getActiveAccount).not.toHaveBeenCalled()
  })

  it("reads the active account's accessToken as authToken", async () => {
    getActiveAccount.mockResolvedValue({ activeAccountId: "acct-1" })
    getAccount.mockResolvedValue({ credential: { accessToken: "live-bearer" } })
    const secrets = await gatherCredentials({ providerSettings: ps({}) })
    expect(secrets.anthropic).toEqual({ authToken: "live-bearer" })
  })

  it("returns null when there is no active account", async () => {
    getActiveAccount.mockResolvedValue({ activeAccountId: undefined })
    const secrets = await gatherCredentials({ providerSettings: ps({}) })
    expect(secrets.anthropic).toBeUndefined()
    expect(getAccount).not.toHaveBeenCalled()
  })

  it("returns null when the credential has no accessToken", async () => {
    getActiveAccount.mockResolvedValue({ activeAccountId: "acct-1" })
    getAccount.mockResolvedValue({ credential: { refreshToken: "r" } })
    const secrets = await gatherCredentials({ providerSettings: ps({}) })
    expect(secrets.anthropic).toBeUndefined()
  })

  it("swallows a transport error and returns null", async () => {
    getActiveAccount.mockRejectedValue(new Error("vault locked"))
    const secrets = await gatherCredentials({ providerSettings: ps({}) })
    expect(secrets.anthropic).toBeUndefined()
  })
})
