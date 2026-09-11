/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"
import type { ApiTestResult } from "@cognia/provider-core/providers/api-test"
import type { UserProviderSettings } from "@cognia/provider-types"

interface SettingsLike {
  settings: {
    providerSettings: Record<string, Partial<UserProviderSettings>>
    customProviders: Array<{
      id: string
      baseURL: string
      apiKey?: string
      apiProtocol?: "openai" | "anthropic"
      defaultModel?: string
      customHeaders?: Record<string, string>
      customName?: string
      customModels?: string[]
      subscription?: Record<string, string>
    }>
    defaultProvider: string
  } | null
  providerUIPreferences: {
    selectedProviderId?: string
    categoryFilter?: string
    statusFilter?: "all" | "connected" | "error" | "not-configured"
  }
  setProviderUIPreferences: jest.Mock
  setProviderConfig: jest.Mock
  setDefaultProvider: jest.Mock
  upsertCustomProvider: jest.Mock
  removeCustomProvider: jest.Mock
}

const settingsState: SettingsLike = {
  settings: {
    providerSettings: {
      openai: { apiKey: "k1", baseURL: "https://api.openai.com" },
    },
    customProviders: [{ id: "cp1", baseURL: "https://x", apiKey: "ck", apiProtocol: "openai" }],
    defaultProvider: "openai",
  },
  providerUIPreferences: {
    selectedProviderId: "openai",
    categoryFilter: "local",
    statusFilter: "connected",
  },
  setProviderUIPreferences: jest.fn().mockResolvedValue(undefined),
  setProviderConfig: jest.fn().mockResolvedValue(undefined),
  setDefaultProvider: jest.fn().mockResolvedValue(undefined),
  upsertCustomProvider: jest.fn().mockResolvedValue(undefined),
  removeCustomProvider: jest.fn().mockResolvedValue(undefined),
}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T>(selector: (s: SettingsLike) => T): T => selector(settingsState),
}))

const testProviderConnection = jest.fn<Promise<ApiTestResult>, [string, string, string?]>()
const testCustomProviderConnectionByProtocol = jest.fn<
  Promise<ApiTestResult>,
  [string, string, string, string?, Record<string, string>?]
>()

jest.mock("@cognia/provider-core/providers/api-test", () => ({
  testProviderConnection: (...args: unknown[]) =>
    testProviderConnection(...(args as [string, string, string?])),
  testCustomProviderConnectionByProtocol: (...args: unknown[]) =>
    testCustomProviderConnectionByProtocol(
      ...(args as [string, string, string, string?, Record<string, string>?])
    ),
}))

const testAndDiscoverBedrock = jest.fn()
jest.mock("@/lib/ai/providers/bedrock-connection", () => ({
  testAndDiscoverBedrock: (...args: unknown[]) => testAndDiscoverBedrock(...args),
}))

const discoverLocalProviderModels = jest.fn()
jest.mock("@cognia/provider-core/providers/model-discovery", () => ({
  discoverLocalProviderModels: (...args: unknown[]) =>
    discoverLocalProviderModels(...(args as [string, string?])),
}))

const subscriptionCredential = jest.fn()
jest.mock("@/lib/claude/provider-attempt-options", () => ({
  resolveSubscriptionProviderCredential: (...args: unknown[]) => subscriptionCredential(...args),
}))
jest.mock("@/lib/share/hash", () => ({
  sha256Hex: async (value: string) =>
    jest
      .requireActual<typeof import("node:crypto")>("node:crypto")
      .createHash("sha256")
      .update(value)
      .digest("hex"),
}))
import { notifySubscriptionChanged } from "@/lib/subscription/core/subscription-events"
import { getBuiltInProviderReadiness } from "@cognia/provider-core/providers/readiness"

import { useProviderSettings } from "./use-provider-settings"

beforeEach(() => {
  jest.clearAllMocks()
  subscriptionCredential.mockReset()
  discoverLocalProviderModels.mockReset()
  // Reset store fixture between tests
  settingsState.settings = {
    providerSettings: {
      openai: { apiKey: "k1", baseURL: "https://api.openai.com" },
    },
    customProviders: [{ id: "cp1", baseURL: "https://x", apiKey: "ck", apiProtocol: "openai" }],
    defaultProvider: "openai",
  }
})

describe("useProviderSettings — derived data", () => {
  it("exposes settings + UI prefs from the store", () => {
    const { result } = renderHook(() => useProviderSettings())
    expect(result.current.providerSettings.openai).toEqual({
      apiKey: "k1",
      baseURL: "https://api.openai.com",
    })
    expect(result.current.customProviders.cp1).toBeDefined()
    expect(result.current.defaultProvider).toBe("openai")
    expect(result.current.uiPreferences).toEqual({
      selectedProviderId: "openai",
      categoryFilter: "local",
      statusFilter: "connected",
    })
    expect(result.current.visibleCustomProviderIds).toEqual(["cp1"])
  })

  it("falls back to empty defaults when settings is null", () => {
    settingsState.settings = null
    const { result } = renderHook(() => useProviderSettings())
    expect(result.current.providerSettings).toEqual({})
    expect(result.current.customProviders).toEqual({})
    expect(result.current.defaultProvider).toBe("")
    expect(result.current.visibleCustomProviderIds).toEqual([])
  })

  it("returns filteredProviders sorted alphabetically by name", () => {
    const { result } = renderHook(() => useProviderSettings())
    const names = result.current.filteredProviders.map(([, p]) => p.name)
    const sorted = [...names].sort((a, b) => a.localeCompare(b))
    expect(names).toEqual(sorted)
  })

  it("restores selectedProviderId from persisted UI preferences", () => {
    const { result } = renderHook(() => useProviderSettings())
    expect(result.current.selectedProviderId).toBe("openai")
  })

  it("setSelectedProviderId persists the selection", async () => {
    const { result } = renderHook(() => useProviderSettings())
    await act(async () => {
      await result.current.setSelectedProviderId("anthropic")
    })
    expect(settingsState.setProviderUIPreferences).toHaveBeenCalledWith({
      selectedProviderId: "anthropic",
    })
  })
})

describe("useProviderSettings — mutations delegate to store", () => {
  it("updateProviderSettings calls setProviderConfig", async () => {
    const { result } = renderHook(() => useProviderSettings())
    await act(async () => {
      await result.current.updateProviderSettings("openai", { apiKey: "new" })
    })
    expect(settingsState.setProviderConfig).toHaveBeenCalledWith("openai", { apiKey: "new" })
  })

  it("updateCustomProvider merges patch and calls upsert", async () => {
    const { result } = renderHook(() => useProviderSettings())
    await act(async () => {
      await result.current.updateCustomProvider("cp1", { apiKey: "new" })
    })
    expect(settingsState.upsertCustomProvider).toHaveBeenCalledWith({
      id: "cp1",
      baseURL: "https://x",
      apiKey: "new",
      apiProtocol: "openai",
      isCustom: true,
    })
  })

  it("updateCustomProvider is a noop for unknown id", async () => {
    const { result } = renderHook(() => useProviderSettings())
    await act(async () => {
      await result.current.updateCustomProvider("missing", { apiKey: "x" })
    })
    expect(settingsState.upsertCustomProvider).not.toHaveBeenCalled()
  })

  it("removeCustomProvider delegates", async () => {
    const { result } = renderHook(() => useProviderSettings())
    await act(async () => {
      await result.current.removeCustomProvider("cp1")
    })
    expect(settingsState.removeCustomProvider).toHaveBeenCalledWith("cp1")
  })

  it("setDefaultProvider delegates", async () => {
    const { result } = renderHook(() => useProviderSettings())
    await act(async () => {
      await result.current.setDefaultProvider("anthropic")
    })
    expect(settingsState.setDefaultProvider).toHaveBeenCalledWith("anthropic")
  })
})

describe("useProviderSettings — testProvider", () => {
  it("uses native Bedrock testing and persists account-aware discovered models", async () => {
    settingsState.settings!.providerSettings.bedrock = {
      providerId: "bedrock",
      enabled: true,
      defaultModel: "us.amazon.nova-lite-v1:0",
      bedrock: { authMode: "default-chain", region: "us-east-1" },
    }
    testAndDiscoverBedrock.mockResolvedValue({
      test: { success: true, outcome: "verified", message: "ok" },
      models: [{ id: "us.amazon.nova-lite-v1:0", name: "US Nova Lite" }],
    })
    const { result } = renderHook(() => useProviderSettings())
    await act(async () => {
      expect((await result.current.testProvider("bedrock"))?.success).toBe(true)
    })
    expect(testProviderConnection).not.toHaveBeenCalled()
    expect(settingsState.setProviderConfig).toHaveBeenCalledWith(
      "bedrock",
      expect.objectContaining({
        discoveredModels: [{ id: "us.amazon.nova-lite-v1:0", name: "US Nova Lite" }],
        discoveredModelsLastFetched: expect.any(Number),
      })
    )
    expect(settingsState.setProviderConfig).toHaveBeenCalledWith(
      "bedrock",
      expect.objectContaining({
        verificationStatus: "verified",
        lastVerifiedAt: expect.any(Number),
        healthStatus: "healthy",
      })
    )
  })

  it("returns null for unknown provider id without calling api-test", async () => {
    const { result } = renderHook(() => useProviderSettings())
    let ret: ApiTestResult | null = { success: true } as ApiTestResult
    await act(async () => {
      ret = await result.current.testProvider("missing")
    })
    expect(ret).toBeNull()
    expect(testProviderConnection).not.toHaveBeenCalled()
  })

  it("stores success result, persists verification status, and clears testing flag", async () => {
    testProviderConnection.mockResolvedValue({
      success: true,
      message: "ok",
      outcome: "verified",
    } as ApiTestResult)
    const { result } = renderHook(() => useProviderSettings())
    await act(async () => {
      const r = await result.current.testProvider("openai")
      expect(r?.success).toBe(true)
    })
    expect(result.current.testResults.openai?.success).toBe(true)
    expect(result.current.testingProviders.openai).toBe(false)
    expect(settingsState.setProviderConfig).toHaveBeenCalledWith(
      "openai",
      expect.objectContaining({
        verificationStatus: "verified",
        lastVerifiedAt: expect.any(Number),
        verificationMessage: "ok",
        healthStatus: "healthy",
      })
    )
  })

  it("persists discovered models for local providers after a successful test", async () => {
    settingsState.settings!.providerSettings.ollama = {
      providerId: "ollama",
      enabled: true,
      defaultModel: "llama3.2",
      baseURL: "http://localhost:11434",
    }
    testProviderConnection.mockResolvedValue({
      success: true,
      message: "ok",
      outcome: "verified",
    } as ApiTestResult)
    discoverLocalProviderModels.mockResolvedValue([
      { id: "llama3.2", name: "llama3.2" },
      { id: "qwen2.5", name: "qwen2.5" },
    ])

    const { result } = renderHook(() => useProviderSettings())
    await act(async () => {
      const r = await result.current.testProvider("ollama")
      expect(r?.success).toBe(true)
    })

    expect(discoverLocalProviderModels).toHaveBeenCalledWith("ollama", "http://localhost:11434")
    expect(settingsState.setProviderConfig).toHaveBeenCalledWith(
      "ollama",
      expect.objectContaining({
        discoveredModels: [
          { id: "llama3.2", name: "llama3.2" },
          { id: "qwen2.5", name: "qwen2.5" },
        ],
        discoveredModelsLastFetched: expect.any(Number),
      })
    )
  })

  it("captures thrown errors as a failed ApiTestResult and persists verification status", async () => {
    testProviderConnection.mockRejectedValue(new Error("boom"))
    const { result } = renderHook(() => useProviderSettings())
    await act(async () => {
      const r = await result.current.testProvider("openai")
      expect(r?.success).toBe(false)
      expect(r?.message).toBe("boom")
    })
    expect(result.current.testResults.openai?.message).toBe("boom")
    expect(settingsState.setProviderConfig).toHaveBeenCalledWith(
      "openai",
      expect.objectContaining({
        verificationStatus: "unverified",
        lastVerifiedAt: expect.any(Number),
        verificationMessage: "boom",
        healthStatus: "error",
      })
    )
  })

  it("stringifies non-Error throws", async () => {
    testProviderConnection.mockRejectedValue("opaque")
    const { result } = renderHook(() => useProviderSettings())
    await act(async () => {
      const r = await result.current.testProvider("openai")
      expect(r?.message).toBe("opaque")
    })
  })
})

describe("useProviderSettings — testCustomProvider", () => {
  it("returns null for unknown id", async () => {
    const { result } = renderHook(() => useProviderSettings())
    let ret: ApiTestResult | null = { success: true } as ApiTestResult
    await act(async () => {
      ret = await result.current.testCustomProvider("missing")
    })
    expect(ret).toBeNull()
    expect(testCustomProviderConnectionByProtocol).not.toHaveBeenCalled()
  })

  it("records success outcome, message, and persists verification status", async () => {
    testCustomProviderConnectionByProtocol.mockResolvedValue({
      success: true,
      message: "yay",
      outcome: "verified",
    } as ApiTestResult)
    const { result } = renderHook(() => useProviderSettings())
    await act(async () => {
      await result.current.testCustomProvider("cp1")
    })
    expect(result.current.customTestResults.cp1).toBe("success")
    expect(result.current.customTestMessages.cp1).toBe("yay")
    expect(result.current.testingCustomProviders.cp1).toBe(false)
    expect(settingsState.upsertCustomProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "cp1",
        verificationStatus: "verified",
        lastVerifiedAt: expect.any(Number),
        verificationMessage: "yay",
        healthStatus: "healthy",
      })
    )
  })

  it("records error outcome and persists verification status when ok=false", async () => {
    testCustomProviderConnectionByProtocol.mockResolvedValue({
      success: false,
      message: "nope",
      outcome: "failed",
    } as ApiTestResult)
    const { result } = renderHook(() => useProviderSettings())
    await act(async () => {
      await result.current.testCustomProvider("cp1")
    })
    expect(result.current.customTestResults.cp1).toBe("error")
    expect(result.current.customTestMessages.cp1).toBe("nope")
    expect(settingsState.upsertCustomProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "cp1",
        verificationStatus: "unverified",
        lastVerifiedAt: expect.any(Number),
        verificationMessage: "nope",
        healthStatus: "error",
      })
    )
  })

  it("captures thrown errors", async () => {
    testCustomProviderConnectionByProtocol.mockRejectedValue(new Error("crash"))
    const { result } = renderHook(() => useProviderSettings())
    await act(async () => {
      const r = await result.current.testCustomProvider("cp1")
      expect(r?.success).toBe(false)
      expect(r?.message).toBe("crash")
    })
    expect(result.current.customTestResults.cp1).toBe("error")
    expect(result.current.customTestMessages.cp1).toBe("crash")
  })

  it("stringifies non-Error throws", async () => {
    testCustomProviderConnectionByProtocol.mockRejectedValue("opaque-x")
    const { result } = renderHook(() => useProviderSettings())
    await act(async () => {
      const r = await result.current.testCustomProvider("cp1")
      expect(r?.message).toBe("opaque-x")
    })
    expect(result.current.customTestMessages.cp1).toBe("opaque-x")
  })

  it("defaults missing apiKey + apiProtocol when calling helper", async () => {
    settingsState.settings = {
      providerSettings: {},
      customProviders: [{ id: "bare", baseURL: "https://b" }],
      defaultProvider: "",
    }
    testCustomProviderConnectionByProtocol.mockResolvedValue({
      success: true,
      message: "ok",
      outcome: "verified",
    } as ApiTestResult)
    const { result } = renderHook(() => useProviderSettings())
    await act(async () => {
      await result.current.testCustomProvider("bare")
    })
    expect(testCustomProviderConnectionByProtocol).toHaveBeenCalledWith(
      "https://b",
      "",
      "openai",
      undefined,
      undefined
    )
  })

  it("forwards the custom provider's default model and static headers to the probe", async () => {
    settingsState.settings = {
      providerSettings: {},
      customProviders: [
        {
          id: "gw",
          baseURL: "https://gw.example/v1",
          apiKey: "k",
          apiProtocol: "openai",
          defaultModel: "gpt-x",
          customHeaders: { "x-tenant": "acme" },
        },
      ],
      defaultProvider: "",
    }
    testCustomProviderConnectionByProtocol.mockResolvedValue({
      success: true,
      message: "ok",
      outcome: "verified",
    } as ApiTestResult)
    const { result } = renderHook(() => useProviderSettings())
    await act(async () => {
      await result.current.testCustomProvider("gw")
    })
    expect(testCustomProviderConnectionByProtocol).toHaveBeenCalledWith(
      "https://gw.example/v1",
      "k",
      "openai",
      "gpt-x",
      { "x-tenant": "acme" }
    )
  })
})

describe("subscription credentials across readiness and connection testing", () => {
  beforeEach(() => {
    settingsState.settings!.providerSettings = { codex: { enabled: false, apiKey: "" } }
    subscriptionCredential.mockResolvedValue({
      apiKey: "vault-secret",
      baseURL: "https://relay.test",
      headers: { "X-Tenant": "team" },
    })
    testProviderConnection.mockResolvedValue({ success: true, message: "Connected" })
  })

  it("enables and tests a vault-only provider without persisting or exposing its secret in settings", async () => {
    const { result } = renderHook(() => useProviderSettings())
    await waitFor(() =>
      expect(result.current.readinessProviderSettings?.codex.apiKey).toMatch(/^subscription:/)
    )
    const readiness = getBuiltInProviderReadiness(
      "codex",
      result.current.readinessProviderSettings?.codex
    )
    expect(readiness.eligibility.enable.allowed).toBe(true)
    expect(readiness.eligibility.testConnection.allowed).toBe(true)
    expect(result.current.readinessProviderSettings?.codex.enabled).toBe(false)
    expect(result.current.providerSettings.codex.apiKey).toBe("")
    await act(async () => {
      await result.current.testProvider("codex")
    })
    expect(testProviderConnection).toHaveBeenCalledWith(
      "codex",
      "vault-secret",
      "https://relay.test",
      { "X-Tenant": "team" }
    )
    expect(JSON.stringify(settingsState.setProviderConfig.mock.calls)).not.toContain("vault-secret")
    expect(settingsState.setProviderConfig).toHaveBeenCalledWith(
      "codex",
      expect.objectContaining({ verificationStatus: "verified" })
    )
  })

  it("revokes readiness and stale results promptly after the subscription account is removed", async () => {
    const { result } = renderHook(() => useProviderSettings())
    await waitFor(() =>
      expect(result.current.readinessProviderSettings?.codex.apiKey).toMatch(/^subscription:/)
    )
    await act(async () => {
      await result.current.testProvider("codex")
    })
    subscriptionCredential.mockResolvedValue(null)
    await act(async () => {
      notifySubscriptionChanged()
    })
    await waitFor(() => expect(result.current.readinessProviderSettings?.codex.apiKey).toBe(""))
    expect(result.current.testResults.codex).toBeUndefined()
  })

  it("resolves current credentials again on Test rather than using the previous readiness projection", async () => {
    const { result } = renderHook(() => useProviderSettings())
    await waitFor(() =>
      expect(result.current.readinessProviderSettings?.codex.apiKey).toMatch(/^subscription:/)
    )
    subscriptionCredential.mockResolvedValue({
      apiKey: "rotated-secret",
      baseURL: "https://new.test",
    })
    await act(async () => {
      await result.current.testProvider("codex")
    })
    expect(testProviderConnection).toHaveBeenCalledWith(
      "codex",
      "rotated-secret",
      "https://new.test",
      undefined
    )
    expect(JSON.stringify(settingsState.setProviderConfig.mock.calls)).not.toContain(
      "rotated-secret"
    )
  })
})

it("discards a connection result when the provider account changes during the request", async () => {
  settingsState.settings!.providerSettings = { codex: { enabled: true, apiKey: "" } }
  subscriptionCredential.mockResolvedValue({ apiKey: "old-token", baseURL: "https://old.test" })
  let finish!: (value: ApiTestResult) => void
  testProviderConnection.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const { result } = renderHook(() => useProviderSettings())
  await waitFor(() =>
    expect(result.current.readinessProviderSettings?.codex.apiKey).toMatch(/^subscription:/)
  )
  let pending!: Promise<ApiTestResult | null>
  await act(async () => {
    pending = result.current.testProvider("codex")
  })
  await waitFor(() => expect(finish).toBeDefined())
  await act(async () => {
    notifySubscriptionChanged()
    finish({ success: true, message: "old account succeeded" })
    await pending
  })
  expect(settingsState.setProviderConfig).not.toHaveBeenCalled()
  expect(result.current.testResults.codex).toBeUndefined()
})

it("offers readiness and connection tests before a subscription provider has any stored API settings", async () => {
  settingsState.settings!.providerSettings = {}
  subscriptionCredential.mockImplementation(async (id: string) =>
    id === "codex" ? { apiKey: "vault-only", baseURL: "https://account.test" } : null
  )
  testProviderConnection.mockResolvedValue({ success: true, message: "Connected" })
  const { result } = renderHook(() => useProviderSettings())
  await waitFor(() => expect(result.current.readinessProviderSettings?.codex.enabled).toBe(false))
  await act(async () => {
    await result.current.testProvider("codex")
  })
  expect(testProviderConnection).toHaveBeenCalledWith(
    "codex",
    "vault-only",
    "https://account.test",
    undefined
  )
})

it("does not report subscription readiness when vault access fails", async () => {
  settingsState.settings!.providerSettings = { codex: { enabled: false, apiKey: "" } }
  subscriptionCredential.mockRejectedValue(new Error("locked"))
  const { result } = renderHook(() => useProviderSettings())
  await act(async () => {
    await Promise.resolve()
  })
  expect(result.current.readinessProviderSettings?.codex.apiKey).toBe("")
  await act(async () => {
    await result.current.testProvider("codex")
  })
  expect(result.current.testResults.codex?.success).toBe(false)
  expect(testProviderConnection).not.toHaveBeenCalled()
})

it("projects CommandCode vault readiness and tests without persisting the key", async () => {
  settingsState.settings!.providerSettings = { commandcode: { enabled: true, apiKey: "" } }
  subscriptionCredential.mockImplementation(async (id: string) =>
    id === "commandcode"
      ? { apiKey: "cmd-vault-secret", baseURL: "https://api.commandcode.ai/provider/v1" }
      : null
  )
  testProviderConnection.mockResolvedValue({ success: true, message: "Connected" })
  const { result } = renderHook(() => useProviderSettings())
  await waitFor(() =>
    expect(result.current.readinessProviderSettings?.commandcode.apiKey).toMatch(/^subscription:/)
  )
  expect(result.current.providerSettings.commandcode.apiKey).toBe("")
  await act(async () => {
    await result.current.testProvider("commandcode")
  })
  expect(testProviderConnection).toHaveBeenCalledWith(
    "commandcode",
    "cmd-vault-secret",
    "https://api.commandcode.ai/provider/v1",
    undefined
  )
})

it("projects custom subscription readiness without leaking the vault credential into editing or persistence", async () => {
  settingsState.settings!.customProviders = [
    {
      id: "custom-vault",
      customName: "Custom Vault",
      baseURL: "https://custom.example/v1",
      apiProtocol: "anthropic",
      customModels: ["claude-test"],
      defaultModel: "claude-test",
      subscription: {},
    },
  ]
  subscriptionCredential.mockImplementation(async (id: string) =>
    id === "custom-vault"
      ? {
          apiKey: "vault-custom-secret",
          baseURL: "https://relay.example",
          headers: { "X-Tenant": "tenant" },
        }
      : null
  )
  testCustomProviderConnectionByProtocol.mockResolvedValue({
    success: true,
    message: "Connected",
    outcome: "verified",
  })
  const { result } = renderHook(() => useProviderSettings())
  await waitFor(() =>
    expect(result.current.readinessCustomProviders?.["custom-vault"].apiKey).toMatch(
      /^subscription:/
    )
  )
  expect(result.current.customProviders["custom-vault"].apiKey).toBeUndefined()
  await act(async () => {
    await result.current.testCustomProvider("custom-vault")
  })
  expect(testCustomProviderConnectionByProtocol).toHaveBeenCalledWith(
    "https://relay.example",
    "vault-custom-secret",
    "anthropic",
    "claude-test",
    { "X-Tenant": "tenant" }
  )
  const saved = settingsState.upsertCustomProvider.mock.calls.at(-1)?.[0]
  expect(saved.verificationStatus).toBe("verified")
  expect(saved.apiKey).toBeUndefined()
  expect(JSON.stringify(saved)).not.toContain("vault-custom-secret")
  expect(JSON.parse(saved.verificationFingerprint).apiKey).toMatch(/^subscription:/)
})

it("discards custom subscription test results when its credential changes during the request", async () => {
  settingsState.settings!.customProviders = [
    {
      id: "custom-vault",
      customName: "Custom Vault",
      baseURL: "https://custom.example/v1",
      apiProtocol: "openai",
      customModels: ["model"],
      defaultModel: "model",
      subscription: {},
    },
  ]
  subscriptionCredential.mockImplementation(async (id: string) =>
    id === "custom-vault" ? { apiKey: "old-secret", baseURL: "https://custom.example/v1" } : null
  )
  let complete!: (result: ApiTestResult) => void
  testCustomProviderConnectionByProtocol.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve
      })
  )
  const { result } = renderHook(() => useProviderSettings())
  await waitFor(() =>
    expect(result.current.readinessCustomProviders?.["custom-vault"].apiKey).toMatch(
      /^subscription:/
    )
  )
  let pending!: Promise<ApiTestResult | null>
  await act(async () => {
    pending = result.current.testCustomProvider("custom-vault")
  })
  await waitFor(() => expect(testCustomProviderConnectionByProtocol).toHaveBeenCalled())
  subscriptionCredential.mockResolvedValue(null)
  act(() => notifySubscriptionChanged())
  await act(async () => {
    complete({ success: true, message: "Old success", outcome: "verified" })
    await pending
  })
  expect(settingsState.upsertCustomProvider).not.toHaveBeenCalled()
  expect(result.current.customTestResults["custom-vault"]).toBeUndefined()
  expect(result.current.readinessCustomProviders?.["custom-vault"].apiKey).toBeUndefined()
})

it("discovers plugin providers dynamically and tests their declared protocol", async () => {
  const { registerPluginSubscriptionProvider, unregisterSubscriptionProvidersByPlugin } =
    await import("@/lib/subscription/core/provider-registry")
  subscriptionCredential.mockImplementation(async (id: string) =>
    id === "settings-test:vendor"
      ? { apiKey: "plugin-secret", baseURL: "https://plugin.example" }
      : null
  )
  testCustomProviderConnectionByProtocol.mockResolvedValue({
    success: true,
    message: "Connected",
    outcome: "verified",
  })
  const { result } = renderHook(() => useProviderSettings())
  expect(result.current.filteredProviders.some(([id]) => id === "settings-test:vendor")).toBe(false)
  try {
    act(() => {
      registerPluginSubscriptionProvider(
        {
          id: "vendor",
          name: "Plugin Vendor",
          baseUrl: "https://plugin.example",
          protocol: "anthropic",
          models: ["claude-test"],
        },
        "settings-test"
      )
    })
    await waitFor(() =>
      expect(result.current.filteredProviders.some(([id]) => id === "settings-test:vendor")).toBe(
        true
      )
    )
    await act(async () => {
      await result.current.testProvider("settings-test:vendor")
    })
    expect(testCustomProviderConnectionByProtocol).toHaveBeenCalledWith(
      "https://plugin.example",
      "plugin-secret",
      "anthropic",
      "claude-test",
      undefined
    )
  } finally {
    act(() => {
      unregisterSubscriptionProvidersByPlugin("settings-test")
    })
  }
  await waitFor(() =>
    expect(result.current.filteredProviders.some(([id]) => id === "settings-test:vendor")).toBe(
      false
    )
  )
})

it("keeps a successful result when persisting verification refreshes the store", async () => {
  testProviderConnection.mockResolvedValue({ success: true, message: "Connected" })
  const { result, rerender } = renderHook(() => useProviderSettings())
  settingsState.setProviderConfig.mockImplementationOnce(async (id, patch) => {
    settingsState.settings = {
      ...settingsState.settings!,
      providerSettings: {
        ...settingsState.settings!.providerSettings,
        [id]: { ...settingsState.settings!.providerSettings[id], ...patch },
      },
    }
    rerender()
  })
  let outcome: ApiTestResult | null = null
  await act(async () => {
    outcome = await result.current.testProvider("openai")
  })
  expect(outcome).toMatchObject({ success: true })
  expect(result.current.testResults.openai?.success).toBe(true)
})

it("keeps custom success when persisting verification refreshes the store", async () => {
  testCustomProviderConnectionByProtocol.mockResolvedValue({ success: true, message: "Connected" })
  const { result, rerender } = renderHook(() => useProviderSettings())
  settingsState.upsertCustomProvider.mockImplementationOnce(async (updated) => {
    settingsState.settings = { ...settingsState.settings!, customProviders: [updated] }
    rerender()
  })
  let outcome: ApiTestResult | null = null
  await act(async () => {
    outcome = await result.current.testCustomProvider("cp1")
  })
  expect(outcome).toMatchObject({ success: true })
  expect(result.current.customTestResults.cp1).toBe("success")
})

it("does not reread vault credentials for unrelated settings changes", async () => {
  settingsState.settings!.providerSettings.codex = { enabled: true, apiKey: "" }
  subscriptionCredential.mockImplementation(async (id: string) =>
    id === "codex" ? { apiKey: "vault-secret", baseURL: "https://account.example" } : null
  )
  const { result, rerender } = renderHook(() => useProviderSettings())
  await waitFor(() =>
    expect(result.current.readinessProviderSettings?.codex.apiKey).toMatch(/^subscription:/)
  )
  subscriptionCredential.mockClear()
  settingsState.settings = Object.assign({}, settingsState.settings, { theme: "dark" })
  rerender()
  await act(async () => {
    await Promise.resolve()
  })
  expect(subscriptionCredential).not.toHaveBeenCalled()
  expect(result.current.readinessProviderSettings?.codex.apiKey).toMatch(/^subscription:/)

  settingsState.settings = Object.assign({}, settingsState.settings, {
    defaultAccountIds: { codex: "replacement-account" },
  })
  rerender()
  await waitFor(() =>
    expect(subscriptionCredential).toHaveBeenCalledWith(
      "codex",
      expect.objectContaining({ defaultAccountIds: { codex: "replacement-account" } })
    )
  )
})
