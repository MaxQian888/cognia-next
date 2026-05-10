/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"
import type { ApiTestResult } from "@/lib/ai/providers/api-test"

interface SettingsLike {
  settings: {
    providerSettings: Record<string, { apiKey?: string; baseURL?: string }>
    customProviders: Array<{
      id: string
      baseURL: string
      apiKey?: string
      apiProtocol?: "openai" | "anthropic"
    }>
    defaultProvider: string
  } | null
  providerUIPreferences: { foo: string }
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
  providerUIPreferences: { foo: "bar" },
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
  [string, string, string]
>()

jest.mock("@/lib/ai/providers/api-test", () => ({
  testProviderConnection: (...args: unknown[]) =>
    testProviderConnection(...(args as [string, string, string?])),
  testCustomProviderConnectionByProtocol: (...args: unknown[]) =>
    testCustomProviderConnectionByProtocol(...(args as [string, string, string])),
}))

import { useProviderSettings } from "./use-provider-settings"

beforeEach(() => {
  jest.clearAllMocks()
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
    expect(result.current.uiPreferences).toEqual({ foo: "bar" })
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

  it("setSelectedProviderId updates local state", () => {
    const { result } = renderHook(() => useProviderSettings())
    expect(result.current.selectedProviderId).toBeNull()
    act(() => result.current.setSelectedProviderId("openai"))
    expect(result.current.selectedProviderId).toBe("openai")
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
  it("returns null for unknown provider id without calling api-test", async () => {
    const { result } = renderHook(() => useProviderSettings())
    let ret: ApiTestResult | null = { success: true } as ApiTestResult
    await act(async () => {
      ret = await result.current.testProvider("missing")
    })
    expect(ret).toBeNull()
    expect(testProviderConnection).not.toHaveBeenCalled()
  })

  it("stores success result and clears testing flag", async () => {
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
  })

  it("captures thrown errors as a failed ApiTestResult", async () => {
    testProviderConnection.mockRejectedValue(new Error("boom"))
    const { result } = renderHook(() => useProviderSettings())
    await act(async () => {
      const r = await result.current.testProvider("openai")
      expect(r?.success).toBe(false)
      expect(r?.message).toBe("boom")
    })
    expect(result.current.testResults.openai?.message).toBe("boom")
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

  it("records success outcome and message", async () => {
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
  })

  it("records error outcome when ok=false", async () => {
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
    expect(testCustomProviderConnectionByProtocol).toHaveBeenCalledWith("https://b", "", "openai")
  })
})
