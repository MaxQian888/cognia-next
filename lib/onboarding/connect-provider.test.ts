const setActiveAccount = jest.fn().mockResolvedValue(undefined)
const setProviderDefaultAccount = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/subscription/core/transport", () => ({
  setActiveAccount: (...a: unknown[]) => setActiveAccount(...a),
}))
jest.mock("@/lib/subscription/core/account-lifecycle", () => ({
  setProviderDefaultAccount: (...a: unknown[]) => setProviderDefaultAccount(...a),
}))

const getBuiltInProviderReadiness = jest.fn(() => ({ readiness: "configured" as string }))
jest.mock("@/components/settings/provider/provider-readiness", () => ({
  getBuiltInProviderReadiness: (...a: unknown[]) => getBuiltInProviderReadiness(...a),
}))

import { connectSubscriptionAccount, saveBuiltInProviderKey } from "./connect-provider"
import type { Account } from "@/types/subscription"

/** The vault's own shape: the identity lives on the credential, not the row. */
const ACCOUNT = {
  id: "acc-1",
  credential: { provider: "codex", email: "a@b.c", chatgptPlanType: "pro" },
} as unknown as Account

beforeEach(() => {
  jest.clearAllMocks()
  getBuiltInProviderReadiness.mockReturnValue({ readiness: "configured" })
})

describe("connectSubscriptionAccount", () => {
  it("writes all three pointers, because three consumers read three places", () => {
    // Dropping the last one is the bug this function exists to make
    // unrepeatable: `build-options` falls through to its literal "anthropic",
    // so a user who connected ChatGPT had their first run sent to Anthropic.
    const setDefaultProvider = jest.fn().mockResolvedValue(undefined)
    return connectSubscriptionAccount({ account: ACCOUNT, setDefaultProvider }).then(() => {
      expect(setActiveAccount).toHaveBeenCalledWith("codex", "acc-1")
      expect(setProviderDefaultAccount).toHaveBeenCalledWith("codex", "acc-1")
      expect(setDefaultProvider).toHaveBeenCalledWith("codex")
    })
  })

  it("returns the summary the caller shows, so it needs no second lookup", async () => {
    const summary = await connectSubscriptionAccount({
      account: ACCOUNT,
      setDefaultProvider: jest.fn().mockResolvedValue(undefined),
    })
    expect(summary.provider).toBe("codex")
    expect(summary.email).toBe("a@b.c")
  })

  it("propagates a failure rather than reporting a half-connected account", async () => {
    setProviderDefaultAccount.mockRejectedValueOnce(new Error("vault locked"))
    await expect(
      connectSubscriptionAccount({
        account: ACCOUNT,
        setDefaultProvider: jest.fn().mockResolvedValue(undefined),
      })
    ).rejects.toThrow("vault locked")
  })
})

describe("saveBuiltInProviderKey", () => {
  const deps = () => ({
    setProviderConfig: jest.fn().mockResolvedValue(undefined),
    setDefaultProvider: jest.fn().mockResolvedValue(undefined),
    setApiKey: jest.fn().mockResolvedValue(undefined),
  })

  it("writes the provider config before pushing the default", async () => {
    // `setDefaultProvider` pushes the sidecar env; doing it first pushes a null
    // key and restarts twice.
    const d = deps()
    const order: string[] = []
    d.setProviderConfig.mockImplementation(async () => void order.push("config"))
    d.setDefaultProvider.mockImplementation(async () => void order.push("default"))

    await saveBuiltInProviderKey({
      draft: {
        providerId: "openai",
        apiKey: "sk-x",
        baseURL: "",
        requiresCredential: true,
        requiresBaseUrl: false,
      },
      ...d,
    })
    expect(order).toEqual(["config", "default"])
  })

  it("writes the legacy Anthropic slot only for Anthropic", async () => {
    // It seeds the Rust `ApiKeyState` at boot, so a stale value would be
    // restored on the next launch — but another provider's key in an
    // Anthropic-shaped env slot is a silent mix-up, not compatibility.
    const anthropic = deps()
    await saveBuiltInProviderKey({
      draft: {
        providerId: "anthropic",
        apiKey: "sk-ant-x",
        baseURL: "",
        requiresCredential: true,
        requiresBaseUrl: false,
      },
      ...anthropic,
    })
    expect(anthropic.setApiKey).toHaveBeenCalledWith("sk-ant-x")

    const openai = deps()
    await saveBuiltInProviderKey({
      draft: {
        providerId: "openai",
        apiKey: "sk-x",
        baseURL: "",
        requiresCredential: true,
        requiresBaseUrl: false,
      },
      ...openai,
    })
    expect(openai.setApiKey).not.toHaveBeenCalled()
  })

  it("trims what it persists", async () => {
    const d = deps()
    await saveBuiltInProviderKey({
      draft: {
        providerId: "openai",
        apiKey: "  sk-x  ",
        baseURL: "",
        requiresCredential: true,
        requiresBaseUrl: false,
      },
      ...d,
    })
    expect(d.setProviderConfig).toHaveBeenCalledWith("openai", { apiKey: "sk-x", enabled: true })
  })

  it("omits the fields the provider does not need", async () => {
    // A local server needs a base URL and no key; sending an empty `apiKey`
    // would make the readiness rules judge a field the provider never asked for.
    const d = deps()
    await saveBuiltInProviderKey({
      draft: {
        providerId: "ollama",
        apiKey: "",
        baseURL: "http://localhost:11434",
        requiresCredential: false,
        requiresBaseUrl: true,
      },
      ...d,
    })
    expect(d.setProviderConfig).toHaveBeenCalledWith("ollama", {
      baseURL: "http://localhost:11434",
      enabled: true,
    })
  })

  it("refuses a draft the Settings page would call unconfigured, and writes nothing", async () => {
    // One opinion about what "enough" means per provider, not two.
    getBuiltInProviderReadiness.mockReturnValue({ readiness: "unconfigured" })
    const d = deps()
    const result = await saveBuiltInProviderKey({
      draft: {
        providerId: "openai",
        apiKey: "",
        baseURL: "",
        requiresCredential: true,
        requiresBaseUrl: false,
      },
      ...d,
    })
    expect(result).toEqual({ ok: false, reason: "incomplete" })
    expect(d.setProviderConfig).not.toHaveBeenCalled()
    expect(d.setDefaultProvider).not.toHaveBeenCalled()
    expect(d.setApiKey).not.toHaveBeenCalled()
  })
})
