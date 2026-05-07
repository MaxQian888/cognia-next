import { act } from "@testing-library/react"
import type { AppSettings } from "@/lib/claude/types"
import {
  DEFAULT_SEARCH_PROVIDER_SETTINGS,
  createDefaultSearchUsageEntry,
  createDefaultSearchUsageStats,
} from "@/lib/search/types"

// ---- Mocks ----

jest.mock("@/lib/db/settings", () => ({
  getSettings: jest.fn(),
  saveSettings: jest.fn(),
  addAlwaysAllow: jest.fn(),
  removeAlwaysAllow: jest.fn(),
}))

jest.mock("@/lib/claude/ipc", () => ({
  setApiKey: jest.fn(),
  restartSidecar: jest.fn(),
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(),
}))

jest.mock("@/lib/tts/keyring", () => ({
  setProviderKey: jest.fn(),
  clearProviderKey: jest.fn(),
  loadAllProviderKeys: jest.fn(),
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const dbSettings = require("@/lib/db/settings") as {
  getSettings: jest.Mock
  saveSettings: jest.Mock
  addAlwaysAllow: jest.Mock
  removeAlwaysAllow: jest.Mock
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ipc = require("@/lib/claude/ipc") as {
  setApiKey: jest.Mock
  restartSidecar: jest.Mock
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tauri = require("@/lib/tauri") as { isTauri: jest.Mock }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const keyring = require("@/lib/tts/keyring") as {
  setProviderKey: jest.Mock
  clearProviderKey: jest.Mock
  loadAllProviderKeys: jest.Mock
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useSettingsStore } = require("./settings-store") as typeof import("./settings-store")

const baseSettings = (overrides: Partial<AppSettings> = {}): AppSettings => ({
  id: "singleton",
  permissionMode: "default",
  alwaysAllowTools: [],
  builtinTools: {
    fileExtras: true,
    git: true,
    process: false,
    environment: true,
    shellAdvanced: false,
  },
  ...overrides,
})

const RESET = { settings: null, loaded: false, providerKeys: {} }

beforeEach(() => {
  jest.clearAllMocks()
  jest.spyOn(console, "warn").mockImplementation(() => {})
  jest.spyOn(console, "error").mockImplementation(() => {})
  useSettingsStore.setState(RESET)
})

afterEach(() => {
  jest.restoreAllMocks()
})

// ---- load ----

describe("load", () => {
  it("fetches settings, marks loaded, and pulls keyring keys when fresh", async () => {
    dbSettings.getSettings.mockResolvedValue(baseSettings({ apiKey: "sk-x" }))
    keyring.loadAllProviderKeys.mockResolvedValue({ openai: "sk-openai" })
    tauri.isTauri.mockReturnValue(true)
    ipc.setApiKey.mockResolvedValue(undefined)

    await act(async () => {
      await useSettingsStore.getState().load()
    })

    const s = useSettingsStore.getState()
    expect(s.loaded).toBe(true)
    expect(s.settings?.apiKey).toBe("sk-x")
    expect(s.providerKeys).toEqual({ openai: "sk-openai" })
    expect(ipc.setApiKey).toHaveBeenCalledWith("sk-x")
    expect(keyring.loadAllProviderKeys).toHaveBeenCalledTimes(1)
  })

  it("short-circuits if already loaded", async () => {
    useSettingsStore.setState({ loaded: true, settings: baseSettings() })
    await useSettingsStore.getState().load()
    expect(dbSettings.getSettings).not.toHaveBeenCalled()
  })

  it("falls back to defaults when getSettings throws", async () => {
    dbSettings.getSettings.mockRejectedValue(new Error("db down"))
    await act(async () => {
      await useSettingsStore.getState().load()
    })
    const s = useSettingsStore.getState()
    expect(s.loaded).toBe(true)
    expect(s.settings).toEqual({
      id: "singleton",
      permissionMode: "default",
      alwaysAllowTools: [],
      builtinTools: {
        fileExtras: true,
        git: true,
        process: false,
        environment: true,
        shellAdvanced: false,
      },
    })
  })

  it("warns but does not throw when loadAllProviderKeys fails", async () => {
    dbSettings.getSettings.mockResolvedValue(baseSettings())
    keyring.loadAllProviderKeys.mockRejectedValue(new Error("keyring err"))
    tauri.isTauri.mockReturnValue(false)
    await act(async () => {
      await useSettingsStore.getState().load()
    })
    expect(useSettingsStore.getState().providerKeys).toEqual({})
    expect(console.warn).toHaveBeenCalled()
  })

  it("does not push apiKey down to Tauri when not in Tauri", async () => {
    dbSettings.getSettings.mockResolvedValue(baseSettings({ apiKey: "sk-y" }))
    keyring.loadAllProviderKeys.mockResolvedValue({})
    tauri.isTauri.mockReturnValue(false)
    await act(async () => {
      await useSettingsStore.getState().load()
    })
    expect(ipc.setApiKey).not.toHaveBeenCalled()
  })

  it("warns when ipc.setApiKey throws during load", async () => {
    dbSettings.getSettings.mockResolvedValue(baseSettings({ apiKey: "sk-x" }))
    keyring.loadAllProviderKeys.mockResolvedValue({})
    tauri.isTauri.mockReturnValue(true)
    ipc.setApiKey.mockRejectedValue(new Error("ipc dead"))
    await act(async () => {
      await useSettingsStore.getState().load()
    })
    expect(console.warn).toHaveBeenCalled()
    expect(useSettingsStore.getState().loaded).toBe(true)
  })

  it("repairs orphaned importedVscodeThemes on load and persists the cleanup", async () => {
    // Two import rows, but only one has a matching customTheme — the
    // other is a leftover from the historical saveSettings race.
    dbSettings.getSettings.mockResolvedValue(
      baseSettings({
        customThemes: [{ id: "ct-keep", name: "Kept" }],
        importedVscodeThemes: [
          {
            customThemeId: "ct-orphan",
            sourceKey: "json:gone.json:Gone",
            sourceName: "Gone",
            sourceVariant: "dark",
            importedAt: 1,
            origin: { kind: "json", fileName: "gone.json" },
          },
          {
            customThemeId: "ct-keep",
            sourceKey: "json:k.json:Kept",
            sourceName: "Kept",
            sourceVariant: "light",
            importedAt: 2,
            origin: { kind: "json", fileName: "k.json" },
          },
        ],
      })
    )
    keyring.loadAllProviderKeys.mockResolvedValue({})
    tauri.isTauri.mockReturnValue(false)
    dbSettings.saveSettings.mockImplementation(async (p) => baseSettings(p))

    await act(async () => {
      await useSettingsStore.getState().load()
    })

    const cleanedRecords = useSettingsStore.getState().settings?.importedVscodeThemes
    expect(cleanedRecords).toHaveLength(1)
    expect(cleanedRecords?.[0].customThemeId).toBe("ct-keep")
    // The cleanup must be persisted so the next load doesn't redo this work.
    expect(dbSettings.saveSettings).toHaveBeenCalledWith({
      importedVscodeThemes: [expect.objectContaining({ customThemeId: "ct-keep" })],
    })
  })
})

// ---- save ----

describe("save", () => {
  it("delegates to saveSettings and writes the result back", async () => {
    const next = baseSettings({ defaultModel: "claude-sonnet" })
    dbSettings.saveSettings.mockResolvedValue(next)
    await act(async () => {
      await useSettingsStore.getState().save({ defaultModel: "claude-sonnet" })
    })
    expect(dbSettings.saveSettings).toHaveBeenCalledWith({ defaultModel: "claude-sonnet" })
    expect(useSettingsStore.getState().settings).toEqual(next)
  })
})

// ---- toggleAlwaysAllow ----

describe("toggleAlwaysAllow", () => {
  it("adds a tool when enabling and reloads", async () => {
    dbSettings.getSettings.mockResolvedValue(baseSettings({ alwaysAllowTools: ["Write"] }))
    await act(async () => {
      await useSettingsStore.getState().toggleAlwaysAllow("Write", true)
    })
    expect(dbSettings.addAlwaysAllow).toHaveBeenCalledWith("Write")
    expect(dbSettings.removeAlwaysAllow).not.toHaveBeenCalled()
    expect(useSettingsStore.getState().settings?.alwaysAllowTools).toContain("Write")
  })

  it("removes a tool when disabling and reloads", async () => {
    dbSettings.getSettings.mockResolvedValue(baseSettings({ alwaysAllowTools: [] }))
    await act(async () => {
      await useSettingsStore.getState().toggleAlwaysAllow("Write", false)
    })
    expect(dbSettings.removeAlwaysAllow).toHaveBeenCalledWith("Write")
    expect(dbSettings.addAlwaysAllow).not.toHaveBeenCalled()
  })
})

// ---- setBuiltinToolEnabled ----

describe("setBuiltinToolEnabled", () => {
  beforeEach(() => {
    // Hydrate the store with a baseline settings row.
    useSettingsStore.setState({ settings: baseSettings(), loaded: true })
  })

  it("flips a single category and persists the rest", async () => {
    const after = baseSettings({
      builtinTools: {
        fileExtras: true,
        git: true,
        process: true,
        environment: true,
        shellAdvanced: false,
      },
    })
    dbSettings.saveSettings.mockResolvedValue(after)
    await act(async () => {
      await useSettingsStore.getState().setBuiltinToolEnabled("process", true)
    })
    expect(dbSettings.saveSettings).toHaveBeenCalledWith({
      builtinTools: {
        fileExtras: true,
        git: true,
        process: true,
        environment: true,
        shellAdvanced: false,
      },
    })
    expect(useSettingsStore.getState().settings?.builtinTools.process).toBe(true)
  })

  it("falls back to defaults if settings.builtinTools was missing", async () => {
    // Older legacy row that hadn't picked up the field.
    useSettingsStore.setState({
      settings: {
        ...baseSettings(),
        // @ts-expect-error — simulating a legacy row missing the field.
        builtinTools: undefined,
      },
    })
    const after = baseSettings({
      builtinTools: {
        fileExtras: true,
        git: true,
        process: false,
        environment: true,
        shellAdvanced: true,
      },
    })
    dbSettings.saveSettings.mockResolvedValue(after)
    await act(async () => {
      await useSettingsStore.getState().setBuiltinToolEnabled("shellAdvanced", true)
    })
    expect(dbSettings.saveSettings).toHaveBeenCalledWith({
      builtinTools: {
        fileExtras: true,
        git: true,
        process: false,
        environment: true,
        shellAdvanced: true,
      },
    })
  })

  it("hydrates from disk if no settings cached in store", async () => {
    useSettingsStore.setState({ settings: null, loaded: false })
    dbSettings.getSettings.mockResolvedValue(baseSettings())
    const after = baseSettings({
      builtinTools: {
        fileExtras: false,
        git: true,
        process: false,
        environment: true,
        shellAdvanced: false,
      },
    })
    dbSettings.saveSettings.mockResolvedValue(after)
    await act(async () => {
      await useSettingsStore.getState().setBuiltinToolEnabled("fileExtras", false)
    })
    expect(dbSettings.getSettings).toHaveBeenCalled()
    expect(dbSettings.saveSettings).toHaveBeenCalled()
  })
})

// ---- setApiKey ----

describe("setApiKey", () => {
  beforeEach(() => {
    dbSettings.saveSettings.mockResolvedValue(baseSettings({ apiKey: "sk-new" }))
  })

  it("trims the key and writes through Dexie", async () => {
    tauri.isTauri.mockReturnValue(false)
    await act(async () => {
      await useSettingsStore.getState().setApiKey("  sk-new  ")
    })
    expect(dbSettings.saveSettings).toHaveBeenCalledWith({ apiKey: "sk-new" })
  })

  it("normalises empty / whitespace-only keys to undefined", async () => {
    tauri.isTauri.mockReturnValue(false)
    dbSettings.saveSettings.mockResolvedValue(baseSettings({ apiKey: undefined }))
    await act(async () => {
      await useSettingsStore.getState().setApiKey("   ")
    })
    expect(dbSettings.saveSettings).toHaveBeenCalledWith({ apiKey: undefined })

    await act(async () => {
      await useSettingsStore.getState().setApiKey(null)
    })
    expect(dbSettings.saveSettings).toHaveBeenCalledWith({ apiKey: undefined })
  })

  it("calls restartSidecar when the key actually changed (Tauri)", async () => {
    tauri.isTauri.mockReturnValue(true)
    ipc.setApiKey.mockResolvedValue(undefined)
    ipc.restartSidecar.mockResolvedValue(undefined)
    useSettingsStore.setState({ settings: baseSettings({ apiKey: "old" }) })
    await act(async () => {
      await useSettingsStore.getState().setApiKey("sk-new")
    })
    expect(ipc.setApiKey).toHaveBeenCalledWith("sk-new")
    expect(ipc.restartSidecar).toHaveBeenCalledTimes(1)
  })

  it("does NOT call restartSidecar when the key did not change", async () => {
    tauri.isTauri.mockReturnValue(true)
    dbSettings.saveSettings.mockResolvedValue(baseSettings({ apiKey: "same" }))
    useSettingsStore.setState({ settings: baseSettings({ apiKey: "same" }) })
    await act(async () => {
      await useSettingsStore.getState().setApiKey("same")
    })
    expect(ipc.restartSidecar).not.toHaveBeenCalled()
  })

  it("does NOT call ipc.setApiKey or restartSidecar when not in Tauri", async () => {
    tauri.isTauri.mockReturnValue(false)
    await act(async () => {
      await useSettingsStore.getState().setApiKey("sk-x")
    })
    expect(ipc.setApiKey).not.toHaveBeenCalled()
    expect(ipc.restartSidecar).not.toHaveBeenCalled()
  })

  it("warns when restartSidecar rejects", async () => {
    tauri.isTauri.mockReturnValue(true)
    ipc.setApiKey.mockResolvedValue(undefined)
    ipc.restartSidecar.mockRejectedValue(new Error("sidecar gone"))
    useSettingsStore.setState({ settings: baseSettings({ apiKey: "old" }) })
    await act(async () => {
      await useSettingsStore.getState().setApiKey("sk-new")
    })
    expect(console.warn).toHaveBeenCalled()
  })
})

// ---- Web search setters (top-level) ----

describe("simple search setters delegating to saveSettings", () => {
  const cases: Array<[keyof ReturnType<typeof useSettingsStore.getState>, unknown, string]> = [
    ["setSearchEnabled", true, "searchEnabled"],
    ["setSearchMaxResults", 25, "searchMaxResults"],
    ["setSearchFallbackEnabled", false, "searchFallbackEnabled"],
    ["setDefaultSearchProvider", "tavily", "defaultSearchProvider"],
    ["setDefaultSearchType", "news", "defaultSearchType"],
    ["setDefaultSearchDepth", "advanced", "defaultSearchDepth"],
    ["setDefaultSearchRecency", "week", "defaultSearchRecency"],
    ["setDefaultSearchCountry", "US", "defaultSearchCountry"],
    ["setDefaultSearchLanguage", "en", "defaultSearchLanguage"],
    ["setDefaultIncludeDomains", ["a.com"], "defaultIncludeDomains"],
    ["setDefaultExcludeDomains", ["b.com"], "defaultExcludeDomains"],
    ["setDefaultIncludeAnswer", true, "defaultIncludeAnswer"],
    ["setDefaultIncludeRawContent", true, "defaultIncludeRawContent"],
    ["setSearchCacheEnabled", true, "searchCacheEnabled"],
    ["setSearchCacheTTL", 60_000, "searchCacheTTL"],
    ["setSearchCacheMaxEntries", 200, "searchCacheMaxEntries"],
    ["setSearchSafeSearchEnabled", true, "searchSafeSearchEnabled"],
    ["setSearchSafeSearchLevel", "strict", "searchSafeSearchLevel"],
    ["setSourceVerificationSettings", { enabled: true }, "sourceVerificationSettings"],
    ["setDefaultSearchSources", ["src-1"], "defaultSearchSources"],
  ]

  it.each(cases)("%s persists patch and updates state", async (action, value, fieldName) => {
    dbSettings.saveSettings.mockResolvedValue(baseSettings())
    await act(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fn = (useSettingsStore.getState() as any)[action]
      await fn(value)
    })
    expect(dbSettings.saveSettings).toHaveBeenCalledWith({ [fieldName]: value })
  })
})

// ---- Per-provider mutators ----

describe("setSearchProviderEnabled / ApiKey / Priority / Settings", () => {
  it("falls back to default providers when settings is null", async () => {
    dbSettings.saveSettings.mockResolvedValue(baseSettings())
    await act(async () => {
      await useSettingsStore.getState().setSearchProviderEnabled("tavily", true)
    })
    const calledWith = dbSettings.saveSettings.mock.calls[0]?.[0] as {
      searchProviders: typeof DEFAULT_SEARCH_PROVIDER_SETTINGS
    }
    expect(calledWith.searchProviders.tavily.enabled).toBe(true)
    // Other providers untouched
    expect(calledWith.searchProviders.perplexity.enabled).toBe(
      DEFAULT_SEARCH_PROVIDER_SETTINGS.perplexity.enabled
    )
  })

  it("merges into the existing providers map", async () => {
    useSettingsStore.setState({
      settings: baseSettings({
        searchProviders: {
          ...DEFAULT_SEARCH_PROVIDER_SETTINGS,
          tavily: { providerId: "tavily", apiKey: "old", enabled: false, priority: 1 },
        },
      }),
    })
    dbSettings.saveSettings.mockResolvedValue(baseSettings())
    await act(async () => {
      await useSettingsStore.getState().setSearchProviderApiKey("tavily", "new-key")
    })
    const arg = dbSettings.saveSettings.mock.calls[0]?.[0] as {
      searchProviders: { tavily: { apiKey: string; enabled: boolean } }
    }
    expect(arg.searchProviders.tavily.apiKey).toBe("new-key")
    // Untouched fields preserved
    expect(arg.searchProviders.tavily.enabled).toBe(false)
  })

  it("setSearchProviderPriority writes priority", async () => {
    dbSettings.saveSettings.mockResolvedValue(baseSettings())
    await act(async () => {
      await useSettingsStore.getState().setSearchProviderPriority("tavily", 9)
    })
    const arg = dbSettings.saveSettings.mock.calls[0]?.[0] as {
      searchProviders: { tavily: { priority: number } }
    }
    expect(arg.searchProviders.tavily.priority).toBe(9)
  })

  it("setSearchProviderSettings merges a partial patch", async () => {
    dbSettings.saveSettings.mockResolvedValue(baseSettings())
    await act(async () => {
      await useSettingsStore
        .getState()
        .setSearchProviderSettings("tavily", { enabled: true, priority: 4 })
    })
    const arg = dbSettings.saveSettings.mock.calls[0]?.[0] as {
      searchProviders: {
        tavily: { providerId: string; apiKey: string; enabled: boolean; priority: number }
      }
    }
    expect(arg.searchProviders.tavily).toEqual({
      providerId: "tavily",
      apiKey: "",
      enabled: true,
      priority: 4,
    })
  })
})

// ---- incrementSearchUsage ----

describe("incrementSearchUsage", () => {
  it("is a no-op when settings is null", () => {
    useSettingsStore.getState().incrementSearchUsage("tavily", 100, true)
    expect(dbSettings.saveSettings).not.toHaveBeenCalled()
  })

  it("seeds default usage stats on first call and increments counters", async () => {
    useSettingsStore.setState({ settings: baseSettings() })
    dbSettings.saveSettings.mockResolvedValue(baseSettings())

    act(() => {
      useSettingsStore.getState().incrementSearchUsage("tavily", 250, true)
    })

    const stats = useSettingsStore.getState().settings?.searchUsageStats
    expect(stats?.tavily.searchCount).toBe(1)
    expect(stats?.tavily.totalResponseTime).toBe(250)
    expect(stats?.tavily.errorCount).toBe(0)
    expect(stats?.tavily.lastUsedAt).not.toBeNull()
  })

  it("counts errors when success is false", () => {
    useSettingsStore.setState({
      settings: baseSettings({
        searchUsageStats: {
          ...createDefaultSearchUsageStats(),
          tavily: { ...createDefaultSearchUsageEntry(), searchCount: 5 },
        },
      }),
    })
    dbSettings.saveSettings.mockResolvedValue(baseSettings())

    act(() => {
      useSettingsStore.getState().incrementSearchUsage("tavily", 50, false)
    })

    const stats = useSettingsStore.getState().settings?.searchUsageStats
    expect(stats?.tavily.searchCount).toBe(6)
    expect(stats?.tavily.errorCount).toBe(1)
  })

  it("warns when the background save rejects", async () => {
    useSettingsStore.setState({ settings: baseSettings() })
    dbSettings.saveSettings.mockRejectedValue(new Error("disk full"))
    act(() => {
      useSettingsStore.getState().incrementSearchUsage("tavily", 1, true)
    })
    // Allow the microtask queue to flush so the .catch fires
    await Promise.resolve()
    await Promise.resolve()
    expect(console.warn).toHaveBeenCalled()
  })

  it("resetSearchUsageStats writes a fresh stats object", async () => {
    dbSettings.saveSettings.mockResolvedValue(baseSettings())
    await act(async () => {
      await useSettingsStore.getState().resetSearchUsageStats()
    })
    const arg = dbSettings.saveSettings.mock.calls[0]?.[0] as {
      searchUsageStats: ReturnType<typeof createDefaultSearchUsageStats>
    }
    expect(arg.searchUsageStats.tavily).toEqual(createDefaultSearchUsageEntry())
  })
})

// ---- Custom search sources ----

describe("custom search sources", () => {
  const source = { id: "src1", name: "Source 1", url: "https://x.com" }

  it("addCustomSearchSource adds a new entry", async () => {
    useSettingsStore.setState({ settings: baseSettings({ customSearchSources: [] }) })
    dbSettings.saveSettings.mockResolvedValue(baseSettings({ customSearchSources: [source] }))
    await act(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await useSettingsStore.getState().addCustomSearchSource(source as any)
    })
    expect(dbSettings.saveSettings).toHaveBeenCalledWith({ customSearchSources: [source] })
  })

  it("addCustomSearchSource is a no-op when the id already exists", async () => {
    useSettingsStore.setState({ settings: baseSettings({ customSearchSources: [source] }) })
    await act(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await useSettingsStore.getState().addCustomSearchSource(source as any)
    })
    expect(dbSettings.saveSettings).not.toHaveBeenCalled()
  })

  it("addCustomSearchSource handles the no-existing-list case (empty default)", async () => {
    useSettingsStore.setState({ settings: baseSettings({ customSearchSources: undefined }) })
    dbSettings.saveSettings.mockResolvedValue(baseSettings({ customSearchSources: [source] }))
    await act(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await useSettingsStore.getState().addCustomSearchSource(source as any)
    })
    expect(dbSettings.saveSettings).toHaveBeenCalledWith({ customSearchSources: [source] })
  })

  it("removeCustomSearchSource filters by id and tolerates missing list", async () => {
    useSettingsStore.setState({ settings: baseSettings({ customSearchSources: [source] }) })
    dbSettings.saveSettings.mockResolvedValue(baseSettings({ customSearchSources: [] }))
    await act(async () => {
      await useSettingsStore.getState().removeCustomSearchSource(source.id)
    })
    expect(dbSettings.saveSettings).toHaveBeenCalledWith({ customSearchSources: [] })

    // No source list — must still call save with [] (filter on undefined defaults to [])
    useSettingsStore.setState({ settings: baseSettings({ customSearchSources: undefined }) })
    dbSettings.saveSettings.mockClear()
    dbSettings.saveSettings.mockResolvedValue(baseSettings({ customSearchSources: [] }))
    await act(async () => {
      await useSettingsStore.getState().removeCustomSearchSource("anything")
    })
    expect(dbSettings.saveSettings).toHaveBeenCalledWith({ customSearchSources: [] })
  })
})

// ---- TTS provider keys ----

describe("provider keys (TTS keyring)", () => {
  it("setProviderApiKey trims, writes, and mirrors into providerKeys", async () => {
    keyring.setProviderKey.mockResolvedValue(undefined)
    await act(async () => {
      await useSettingsStore.getState().setProviderApiKey("openai", "  sk-trim  ")
    })
    expect(keyring.setProviderKey).toHaveBeenCalledWith("openai", "sk-trim")
    expect(useSettingsStore.getState().providerKeys.openai).toBe("sk-trim")
  })

  it("setProviderApiKey stores undefined when the trimmed string is empty", async () => {
    keyring.setProviderKey.mockResolvedValue(undefined)
    await act(async () => {
      await useSettingsStore.getState().setProviderApiKey("openai", "    ")
    })
    expect(useSettingsStore.getState().providerKeys.openai).toBeUndefined()
  })

  it("clearProviderApiKey removes the slot", async () => {
    useSettingsStore.setState({ providerKeys: { openai: "sk-x" } })
    keyring.clearProviderKey.mockResolvedValue(undefined)
    await act(async () => {
      await useSettingsStore.getState().clearProviderApiKey("openai")
    })
    expect(keyring.clearProviderKey).toHaveBeenCalledWith("openai")
    expect(useSettingsStore.getState().providerKeys.openai).toBeUndefined()
  })

  it("refreshProviderKeys overwrites on success", async () => {
    keyring.loadAllProviderKeys.mockResolvedValue({ openai: "fresh" })
    await act(async () => {
      await useSettingsStore.getState().refreshProviderKeys()
    })
    expect(useSettingsStore.getState().providerKeys.openai).toBe("fresh")
  })

  it("refreshProviderKeys warns and keeps existing keys on failure", async () => {
    useSettingsStore.setState({ providerKeys: { openai: "stale" } })
    keyring.loadAllProviderKeys.mockRejectedValue(new Error("offline"))
    await act(async () => {
      await useSettingsStore.getState().refreshProviderKeys()
    })
    expect(useSettingsStore.getState().providerKeys.openai).toBe("stale")
    expect(console.warn).toHaveBeenCalled()
  })
})

// ---- TTS settings ----

describe("TTS feature toggles and clamps", () => {
  beforeEach(() => {
    dbSettings.saveSettings.mockResolvedValue(baseSettings())
  })

  const passthroughCases: Array<[string, unknown, string]> = [
    ["setTtsEnabled", true, "ttsEnabled"],
    ["setTtsProvider", "openai", "ttsProvider"],
    ["setTtsAutoPlay", true, "ttsAutoPlay"],
  ]

  it.each(passthroughCases)("%s passes value through verbatim", async (action, value, field) => {
    await act(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (useSettingsStore.getState() as any)[action](value)
    })
    expect(dbSettings.saveSettings).toHaveBeenCalledWith({ [field]: value })
  })

  it("setTtsRate clamps to [0.1, 10]", async () => {
    await act(async () => {
      await useSettingsStore.getState().setTtsRate(20)
    })
    expect(dbSettings.saveSettings).toHaveBeenLastCalledWith({ ttsRate: 10 })

    await act(async () => {
      await useSettingsStore.getState().setTtsRate(-5)
    })
    expect(dbSettings.saveSettings).toHaveBeenLastCalledWith({ ttsRate: 0.1 })

    await act(async () => {
      await useSettingsStore.getState().setTtsRate(1.5)
    })
    expect(dbSettings.saveSettings).toHaveBeenLastCalledWith({ ttsRate: 1.5 })
  })

  it("setTtsPitch clamps to [0, 2]", async () => {
    await act(async () => {
      await useSettingsStore.getState().setTtsPitch(5)
    })
    expect(dbSettings.saveSettings).toHaveBeenLastCalledWith({ ttsPitch: 2 })

    await act(async () => {
      await useSettingsStore.getState().setTtsPitch(-1)
    })
    expect(dbSettings.saveSettings).toHaveBeenLastCalledWith({ ttsPitch: 0 })
  })

  it("setTtsVolume clamps to [0, 1]", async () => {
    await act(async () => {
      await useSettingsStore.getState().setTtsVolume(2)
    })
    expect(dbSettings.saveSettings).toHaveBeenLastCalledWith({ ttsVolume: 1 })

    await act(async () => {
      await useSettingsStore.getState().setTtsVolume(-3)
    })
    expect(dbSettings.saveSettings).toHaveBeenLastCalledWith({ ttsVolume: 0 })
  })
})

// ---- Coverage for fallback branches ----

describe("fallback branches (existing-map-missing-id and friends)", () => {
  it("setSearchProviderEnabled falls back to DEFAULT entry when providers map lacks the id", async () => {
    // providers map exists but is empty — forces `providers[id] ?? defaults[id]` fallback
    useSettingsStore.setState({
      settings: baseSettings({
        searchProviders: {} as Record<string, never>,
      }),
    })
    dbSettings.saveSettings.mockResolvedValue(baseSettings())
    await act(async () => {
      await useSettingsStore.getState().setSearchProviderEnabled("tavily", true)
    })
    const arg = dbSettings.saveSettings.mock.calls[0]?.[0] as {
      searchProviders: { tavily: { providerId: string; enabled: boolean } }
    }
    expect(arg.searchProviders.tavily.enabled).toBe(true)
    expect(arg.searchProviders.tavily.providerId).toBe("tavily")
  })

  it("setSearchProviderApiKey, Priority, Settings all use the same fallback", async () => {
    useSettingsStore.setState({
      settings: baseSettings({ searchProviders: {} as Record<string, never> }),
    })
    dbSettings.saveSettings.mockResolvedValue(baseSettings())

    await act(async () => {
      await useSettingsStore.getState().setSearchProviderApiKey("tavily", "X")
    })
    await act(async () => {
      await useSettingsStore.getState().setSearchProviderPriority("tavily", 7)
    })
    await act(async () => {
      await useSettingsStore.getState().setSearchProviderSettings("tavily", { enabled: true })
    })

    expect(dbSettings.saveSettings).toHaveBeenCalledTimes(3)
  })

  it("incrementSearchUsage seeds an entry from defaults when stats is present but lacks the id", () => {
    useSettingsStore.setState({
      settings: baseSettings({
        searchUsageStats: {} as Record<string, never>,
      }),
    })
    dbSettings.saveSettings.mockResolvedValue(baseSettings())
    act(() => {
      useSettingsStore.getState().incrementSearchUsage("tavily", 100, true)
    })
    const stats = useSettingsStore.getState().settings?.searchUsageStats
    expect(stats?.tavily.searchCount).toBe(1)
    expect(stats?.tavily.totalResponseTime).toBe(100)
  })

  it("syncApiKeyToTauri converts whitespace-only key to null when in Tauri", async () => {
    // Ensures the `key && key.trim() ? key : null` falsy branch is exercised
    tauri.isTauri.mockReturnValue(true)
    ipc.setApiKey.mockResolvedValue(undefined)
    dbSettings.saveSettings.mockResolvedValue(baseSettings({ apiKey: undefined }))
    useSettingsStore.setState({ settings: baseSettings({ apiKey: "old" }) })

    await act(async () => {
      await useSettingsStore.getState().setApiKey("   ")
    })
    // Inside syncApiKeyToTauri, the `key && key.trim()` check on the trimmed
    // arg (undefined here) falls to the null branch.
    expect(ipc.setApiKey).toHaveBeenCalledWith(null)
  })
})

// ----------------------------------------------------------------------------
// Appearance setters
// ----------------------------------------------------------------------------

describe("appearance setters", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DEFAULT_BACKGROUND_SETTINGS } = require("@/types/appearance") as {
    DEFAULT_BACKGROUND_SETTINGS: {
      enabled: boolean
      activeId: string | null
      scope: "all" | "global" | "chat" | "canvas" | "sidebar"
      blurPx: number
      opacity: number
      position: "cover" | "contain" | "tile" | "center"
    }
  }

  type Wallpaper = {
    id: string
    name: string
    kind: "image" | "gradient" | "color"
    builtin: boolean
    createdAt: number
    source: { kind: "gradient"; css: string } | { kind: "color"; value: string }
  }

  const wp = (id: string, builtin = false): Wallpaper => ({
    id,
    name: id,
    kind: "gradient",
    builtin,
    createdAt: 1,
    source: { kind: "gradient", css: "linear-gradient(0deg, #fff, #000)" },
  })

  it("setBackground merges patch into the saved row", async () => {
    useSettingsStore.setState({
      settings: baseSettings({ background: { ...DEFAULT_BACKGROUND_SETTINGS } }),
    })
    dbSettings.saveSettings.mockImplementation(async (patch) =>
      baseSettings({ background: patch.background })
    )
    await act(async () => {
      await useSettingsStore.getState().setBackground({ blurPx: 8, opacity: 0.7 })
    })
    expect(dbSettings.saveSettings).toHaveBeenCalledWith({
      background: { ...DEFAULT_BACKGROUND_SETTINGS, blurPx: 8, opacity: 0.7 },
    })
  })

  it("addWallpaper ignores duplicates by id", async () => {
    const existing = wp("a")
    useSettingsStore.setState({ settings: baseSettings({ wallpapers: [existing] }) })
    dbSettings.saveSettings.mockResolvedValue(baseSettings({ wallpapers: [existing] }))
    await act(async () => {
      await useSettingsStore.getState().addWallpaper(existing)
    })
    expect(dbSettings.saveSettings).not.toHaveBeenCalled()
  })

  it("addWallpaper appends a new wallpaper", async () => {
    useSettingsStore.setState({ settings: baseSettings({ wallpapers: [] }) })
    const incoming = wp("b")
    dbSettings.saveSettings.mockResolvedValue(baseSettings({ wallpapers: [incoming] }))
    await act(async () => {
      await useSettingsStore.getState().addWallpaper(incoming)
    })
    expect(dbSettings.saveSettings).toHaveBeenCalledWith({ wallpapers: [incoming] })
  })

  it("updateWallpaper merges into the matching row, preserving id", async () => {
    const existing = wp("a")
    useSettingsStore.setState({ settings: baseSettings({ wallpapers: [existing] }) })
    dbSettings.saveSettings.mockImplementation(async (p) =>
      baseSettings({ wallpapers: p.wallpapers })
    )
    await act(async () => {
      await useSettingsStore
        .getState()
        .updateWallpaper("a", { name: "renamed", id: "ignored" } as Partial<Wallpaper>)
    })
    expect(dbSettings.saveSettings).toHaveBeenCalledWith({
      wallpapers: [{ ...existing, name: "renamed" }],
    })
  })

  it("updateWallpaper is a no-op when id is unknown", async () => {
    useSettingsStore.setState({ settings: baseSettings({ wallpapers: [wp("a")] }) })
    await act(async () => {
      await useSettingsStore.getState().updateWallpaper("missing", { name: "x" })
    })
    expect(dbSettings.saveSettings).not.toHaveBeenCalled()
  })

  it("deleteWallpaper refuses built-in wallpapers", async () => {
    const builtin = wp("preset", true)
    useSettingsStore.setState({ settings: baseSettings({ wallpapers: [builtin] }) })
    await act(async () => {
      await useSettingsStore.getState().deleteWallpaper("preset")
    })
    expect(dbSettings.saveSettings).not.toHaveBeenCalled()
  })

  it("deleteWallpaper clears active background when the deleted one was active", async () => {
    const a = wp("a")
    const b = wp("b")
    useSettingsStore.setState({
      settings: baseSettings({
        wallpapers: [a, b],
        background: {
          ...DEFAULT_BACKGROUND_SETTINGS,
          enabled: true,
          activeId: "a",
        },
      }),
    })
    dbSettings.saveSettings.mockImplementation(async (p) => baseSettings(p))
    await act(async () => {
      await useSettingsStore.getState().deleteWallpaper("a")
    })
    expect(dbSettings.saveSettings).toHaveBeenCalledWith({
      wallpapers: [b],
      background: { ...DEFAULT_BACKGROUND_SETTINGS, activeId: null, enabled: false },
    })
  })

  it("deleteWallpaper without active match only filters the list", async () => {
    const a = wp("a")
    const b = wp("b")
    useSettingsStore.setState({
      settings: baseSettings({
        wallpapers: [a, b],
        background: { ...DEFAULT_BACKGROUND_SETTINGS, activeId: "b", enabled: true },
      }),
    })
    dbSettings.saveSettings.mockImplementation(async (p) => baseSettings(p))
    await act(async () => {
      await useSettingsStore.getState().deleteWallpaper("a")
    })
    expect(dbSettings.saveSettings).toHaveBeenCalledWith({ wallpapers: [b] })
  })

  it("setActiveWallpaper enables background when given an id", async () => {
    useSettingsStore.setState({
      settings: baseSettings({ background: { ...DEFAULT_BACKGROUND_SETTINGS } }),
    })
    dbSettings.saveSettings.mockImplementation(async (p) => baseSettings(p))
    await act(async () => {
      await useSettingsStore.getState().setActiveWallpaper("wp-1")
    })
    expect(dbSettings.saveSettings).toHaveBeenCalledWith({
      background: { ...DEFAULT_BACKGROUND_SETTINGS, activeId: "wp-1", enabled: true },
    })
  })

  it("setActiveWallpaper(null) disables background", async () => {
    useSettingsStore.setState({
      settings: baseSettings({
        background: { ...DEFAULT_BACKGROUND_SETTINGS, activeId: "x", enabled: true },
      }),
    })
    dbSettings.saveSettings.mockImplementation(async (p) => baseSettings(p))
    await act(async () => {
      await useSettingsStore.getState().setActiveWallpaper(null)
    })
    expect(dbSettings.saveSettings).toHaveBeenCalledWith({
      background: { ...DEFAULT_BACKGROUND_SETTINGS, activeId: null, enabled: false },
    })
  })

  it("setCustomCss + setCustomCssEnabled save through", async () => {
    useSettingsStore.setState({ settings: baseSettings() })
    dbSettings.saveSettings.mockImplementation(async (p) => baseSettings(p))
    await act(async () => {
      await useSettingsStore.getState().setCustomCss("body { color: red; }")
      await useSettingsStore.getState().setCustomCssEnabled(true)
    })
    expect(dbSettings.saveSettings).toHaveBeenNthCalledWith(1, {
      customCss: "body { color: red; }",
    })
    expect(dbSettings.saveSettings).toHaveBeenNthCalledWith(2, { customCssEnabled: true })
  })

  it("addImportedTheme replaces an existing record for the same customThemeId", async () => {
    const r1 = {
      customThemeId: "ct-1",
      sourceName: "old",
      sourceVariant: "dark" as const,
      importedAt: 1,
      origin: { kind: "json" as const, fileName: "a.json" },
    }
    const r2 = { ...r1, sourceName: "new", importedAt: 2 }
    useSettingsStore.setState({ settings: baseSettings({ importedVscodeThemes: [r1] }) })
    dbSettings.saveSettings.mockImplementation(async (p) => baseSettings(p))
    await act(async () => {
      await useSettingsStore.getState().addImportedTheme(r2)
    })
    expect(dbSettings.saveSettings).toHaveBeenCalledWith({ importedVscodeThemes: [r2] })
  })

  it("removeImportedTheme filters by customThemeId", async () => {
    const records = [
      {
        customThemeId: "ct-1",
        sourceName: "a",
        sourceVariant: "light" as const,
        importedAt: 1,
        origin: { kind: "json" as const, fileName: "a.json" },
      },
      {
        customThemeId: "ct-2",
        sourceName: "b",
        sourceVariant: "dark" as const,
        importedAt: 2,
        origin: { kind: "json" as const, fileName: "b.json" },
      },
    ]
    useSettingsStore.setState({ settings: baseSettings({ importedVscodeThemes: records }) })
    dbSettings.saveSettings.mockImplementation(async (p) => baseSettings(p))
    await act(async () => {
      await useSettingsStore.getState().removeImportedTheme("ct-1")
    })
    expect(dbSettings.saveSettings).toHaveBeenCalledWith({
      importedVscodeThemes: [records[1]],
    })
  })
})

describe("repairImportedVscodeThemes", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { repairImportedVscodeThemes } =
    require("./settings-store") as typeof import("./settings-store")

  it("returns the same object reference when nothing needs repair", () => {
    const s = baseSettings({
      customThemes: [{ id: "ct-1", name: "Dracula" }],
      importedVscodeThemes: [
        {
          customThemeId: "ct-1",
          sourceKey: "json:dracula.json:Dracula",
          sourceName: "Dracula",
          sourceVariant: "dark",
          importedAt: 1,
          origin: { kind: "json", fileName: "dracula.json" },
        },
      ],
    })
    expect(repairImportedVscodeThemes(s)).toBe(s)
  })

  it("drops history rows whose customThemeId no longer exists", () => {
    const s = baseSettings({
      customThemes: [{ id: "ct-keep", name: "Kept" }],
      importedVscodeThemes: [
        {
          customThemeId: "ct-orphan",
          sourceKey: "json:gone.json:Gone",
          sourceName: "Gone",
          sourceVariant: "dark",
          importedAt: 1,
          origin: { kind: "json", fileName: "gone.json" },
        },
        {
          customThemeId: "ct-keep",
          sourceKey: "json:k.json:Kept",
          sourceName: "Kept",
          sourceVariant: "light",
          importedAt: 2,
          origin: { kind: "json", fileName: "k.json" },
        },
      ],
    })
    const out = repairImportedVscodeThemes(s)
    expect(out).not.toBe(s)
    expect(out.importedVscodeThemes).toHaveLength(1)
    expect(out.importedVscodeThemes?.[0].customThemeId).toBe("ct-keep")
  })

  it("collapses duplicate sourceKey rows to the most recent importedAt", () => {
    const s = baseSettings({
      customThemes: [
        { id: "ct-1", name: "Night Owl" },
        { id: "ct-2", name: "Night Owl" },
      ],
      importedVscodeThemes: [
        {
          customThemeId: "ct-1",
          sourceKey: "vsix:night-owl.vsix:themes/Night Owl-color-theme.json",
          sourceName: "Night Owl",
          sourceVariant: "dark",
          importedAt: 100,
          origin: {
            kind: "vsix",
            vsixName: "night-owl.vsix",
            themePath: "themes/Night Owl-color-theme.json",
          },
        },
        {
          customThemeId: "ct-2",
          sourceKey: "vsix:night-owl.vsix:themes/Night Owl-color-theme.json",
          sourceName: "Night Owl",
          sourceVariant: "dark",
          importedAt: 200,
          origin: {
            kind: "vsix",
            vsixName: "night-owl.vsix",
            themePath: "themes/Night Owl-color-theme.json",
          },
        },
      ],
    })
    const out = repairImportedVscodeThemes(s)
    expect(out.importedVscodeThemes).toHaveLength(1)
    expect(out.importedVscodeThemes?.[0].customThemeId).toBe("ct-2")
  })

  it("preserves rows that have no sourceKey (pre-fix data) instead of folding them by name", () => {
    const s = baseSettings({
      customThemes: [
        { id: "ct-1", name: "Old A" },
        { id: "ct-2", name: "Old B" },
      ],
      importedVscodeThemes: [
        {
          customThemeId: "ct-1",
          sourceName: "Old A",
          sourceVariant: "dark",
          importedAt: 1,
          origin: { kind: "json", fileName: "old.json" },
        },
        {
          customThemeId: "ct-2",
          sourceName: "Old B",
          sourceVariant: "dark",
          importedAt: 2,
          origin: { kind: "json", fileName: "old.json" },
        },
      ],
    })
    const out = repairImportedVscodeThemes(s)
    expect(out).toBe(s)
  })
})
