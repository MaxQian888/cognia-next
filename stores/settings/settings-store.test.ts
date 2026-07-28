/** @jest-environment jsdom */
import { act } from "@testing-library/react"
import type { AppSettings } from "@cognia/agent-config-types"
import {
  DEFAULT_SEARCH_PROVIDER_SETTINGS,
  createDefaultSearchUsageEntry,
  createDefaultSearchUsageStats,
} from "@cognia/web-search/types"

// ---- Mocks ----

jest.mock("@/lib/db/settings", () => ({
  getSettings: jest.fn(),
  saveSettings: jest.fn(),
  addAlwaysAllow: jest.fn(),
  removeAlwaysAllow: jest.fn(),
  // Consumed by profile-transfer (dynamically imported by resetSettings).
  DEFAULTS: {
    id: "singleton",
    updatedAt: 0,
    installUuid: "uuid",
    apiKey: "secret",
    apiBaseUrl: "https://x",
    theme: "system",
    language: "en",
  },
}))

jest.mock("@/lib/claude/ipc", () => ({
  setApiKey: jest.fn(),
  restartSidecar: jest.fn(),
  setProviderEnv: jest.fn(),
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(),
}))

const dispatchDiagnosticMock = jest.fn()
jest.mock("@/lib/diagnostics/bus", () => ({
  dispatchDiagnostic: (...args: unknown[]) => dispatchDiagnosticMock(...args),
}))

const applyProxyToRustMock = jest.fn()
jest.mock("@/stores/network-proxy", () => ({
  applyProxyToRust: (...args: unknown[]) => applyProxyToRustMock(...args),
  maybeAutoDetectProxy: jest.fn(),
}))

jest.mock("@/lib/tts/keyring", () => ({
  setProviderKey: jest.fn(),
  clearProviderKey: jest.fn(),
  loadAllProviderKeys: jest.fn(),
}))

jest.mock("@/lib/plugin/messaging/message-bus", () => {
  const actual = jest.requireActual("@/lib/plugin/messaging/message-bus")
  return { ...actual, emitSystemBusEvent: jest.fn() }
})

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
  setProviderEnv: jest.Mock
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
// eslint-disable-next-line @typescript-eslint/no-require-imports
const messageBus = require("@/lib/plugin/messaging/message-bus") as {
  emitSystemBusEvent: jest.Mock
  SystemEvents: typeof import("@/lib/plugin/messaging/message-bus").SystemEvents
}
const mockedEmit = messageBus.emitSystemBusEvent as jest.Mock

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

const RESET = {
  settings: null,
  loaded: false,
  loadFailed: false,
  loadError: null,
  providerKeys: {},
  providerKeysLoaded: false,
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.spyOn(console, "warn").mockImplementation(() => {})
  jest.spyOn(console, "error").mockImplementation(() => {})
  dispatchDiagnosticMock.mockClear()
  applyProxyToRustMock.mockReset().mockResolvedValue(undefined)
  useSettingsStore.setState(RESET)
})

afterEach(() => {
  jest.restoreAllMocks()
})

// ---- load ----

describe("load", () => {
  it("fetches settings and pushes the api key, but does NOT pull keyring keys at boot", async () => {
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
    expect(ipc.setApiKey).toHaveBeenCalledWith("sk-x")
    // TTS keys are loaded lazily via `ensureProviderKeys`, never during boot
    // `load()` — keeps the `1 + N` keyring round-trips off the startup path.
    expect(s.providerKeys).toEqual({})
    expect(s.providerKeysLoaded).toBe(false)
    expect(keyring.loadAllProviderKeys).not.toHaveBeenCalled()
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
        coreFiles: true,
        fileExtras: true,
        git: true,
        process: false,
        environment: true,
        shellAdvanced: false,
        terminalRepl: false,
        lsp: false,
        astGrep: false,
        codeGraph: false,
        dependencyResearch: false,
        webclone: false,
      },
      updates: {
        autoCheck: true,
        checkIntervalMinutes: 360,
        autoDownload: false,
        relaunchAfterInstall: true,
        requestTimeoutSeconds: 30,
        useProxy: true,
      },
      canvasCodeSandboxEnabled: true,
    })
  })

  it("flags the defaults fallback so the session isn't silently degraded", async () => {
    dbSettings.getSettings.mockRejectedValue(new Error("db down"))
    await act(async () => {
      await useSettingsStore.getState().load()
    })
    const s = useSettingsStore.getState()
    expect(s.loadFailed).toBe(true)
    expect(s.loadError).toBe("db down")
  })

  it("clears the failure flags on a successful load", async () => {
    useSettingsStore.setState({ loadFailed: true, loadError: "stale" })
    dbSettings.getSettings.mockResolvedValue(baseSettings())
    await act(async () => {
      await useSettingsStore.getState().load()
    })
    const s = useSettingsStore.getState()
    expect(s.loadFailed).toBe(false)
    expect(s.loadError).toBeNull()
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

  it("seeds default tier mappings on load for a fresh user and persists them", async () => {
    dbSettings.getSettings.mockResolvedValue(
      baseSettings({
        modelMappings: undefined,
        providerSettings: {
          openai: { enabled: true },
        } as unknown as AppSettings["providerSettings"],
      })
    )
    keyring.loadAllProviderKeys.mockResolvedValue({})
    tauri.isTauri.mockReturnValue(false)
    dbSettings.saveSettings.mockImplementation(async (p) => baseSettings(p))

    await act(async () => {
      await useSettingsStore.getState().load()
    })

    const saved = dbSettings.saveSettings.mock.calls[0]?.[0]
    expect(saved?.modelMappings?.length).toBeGreaterThan(0)
    expect(saved?.modelMappings?.some((m: { alias: string }) => m.alias === "fast")).toBe(true)
    expect(useSettingsStore.getState().settings?.modelMappings?.length).toBeGreaterThan(0)
  })

  it("does NOT reseed mappings on load when the user already has some", async () => {
    dbSettings.getSettings.mockResolvedValue(
      baseSettings({
        modelMappings: [
          {
            id: "existing",
            alias: "fast",
            providers: [{ providerId: "openai", modelId: "gpt-4o" }],
            distribution: "priority",
            enabled: true,
            createdAt: 0,
            updatedAt: 0,
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

    // No saveSettings call carries modelMappings (nothing to persist).
    for (const call of dbSettings.saveSettings.mock.calls) {
      expect(call[0]?.modelMappings).toBeUndefined()
    }
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
    // (Fresh-user mapping seeding may ride along in the same patch, so match
    // on the importedVscodeThemes field specifically.)
    expect(dbSettings.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        importedVscodeThemes: [expect.objectContaining({ customThemeId: "ct-keep" })],
      })
    )
  })
})

// ---- save ----

describe("silent side-effect failures", () => {
  it("reports a proxy that never reached the Rust side", async () => {
    // Outgoing requests are now bypassing a proxy the user configured — a
    // privacy consequence that used to be a lone console.warn.
    dbSettings.saveSettings.mockResolvedValue(baseSettings())
    applyProxyToRustMock.mockRejectedValue(new Error("rust down"))
    await act(async () => {
      await useSettingsStore.getState().save({ networkProxy: { mode: "manual" } as never })
    })
    expect(dispatchDiagnosticMock).toHaveBeenCalledWith(
      expect.objectContaining({ code: "proxyApplyFailed", source: "settings" })
    )
  })

  it("stays quiet when the proxy applied cleanly", async () => {
    dbSettings.saveSettings.mockResolvedValue(baseSettings())
    await act(async () => {
      await useSettingsStore.getState().save({ networkProxy: { mode: "manual" } as never })
    })
    expect(applyProxyToRustMock).toHaveBeenCalled()
    expect(dispatchDiagnosticMock).not.toHaveBeenCalled()
  })
})

describe("retryLoad", () => {
  it("re-reads settings even though load() already ran", async () => {
    dbSettings.getSettings.mockRejectedValueOnce(new Error("db down"))
    await act(async () => {
      await useSettingsStore.getState().load()
    })
    expect(useSettingsStore.getState().loadFailed).toBe(true)

    dbSettings.getSettings.mockResolvedValue(baseSettings({ apiKey: "sk-recovered" }))
    await act(async () => {
      await useSettingsStore.getState().retryLoad()
    })

    const s = useSettingsStore.getState()
    expect(s.loadFailed).toBe(false)
    expect(s.loadError).toBeNull()
    expect(s.settings?.apiKey).toBe("sk-recovered")
  })

  it("re-flags the failure when the retry also throws", async () => {
    dbSettings.getSettings.mockRejectedValue(new Error("still down"))
    await act(async () => {
      await useSettingsStore.getState().load()
      await useSettingsStore.getState().retryLoad()
    })
    const s = useSettingsStore.getState()
    expect(s.loadFailed).toBe(true)
    expect(s.loadError).toBe("still down")
    expect(s.loaded).toBe(true)
  })
})

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

  it("serializes updater preference patches without losing earlier changes", async () => {
    dbSettings.saveSettings.mockImplementation(async (patch) => baseSettings(patch))
    useSettingsStore.setState({ settings: baseSettings() })

    await act(async () => {
      await Promise.all([
        useSettingsStore.getState().saveUpdateSettings({ autoDownload: true }),
        useSettingsStore.getState().saveUpdateSettings({ checkIntervalMinutes: 15 }),
      ])
    })

    expect(dbSettings.saveSettings).toHaveBeenLastCalledWith({
      updates: expect.objectContaining({ autoDownload: true, checkIntervalMinutes: 15 }),
    })
  })

  it("serializes partial updater settings without losing rapid changes", async () => {
    const initialUpdates = {
      autoCheck: true,
      checkIntervalMinutes: 360,
      autoDownload: false,
      relaunchAfterInstall: true,
      requestTimeoutSeconds: 30,
      useProxy: true,
    }
    useSettingsStore.setState({ settings: baseSettings({ updates: initialUpdates }) })
    let releaseFirst!: () => void
    dbSettings.saveSettings
      .mockImplementationOnce(
        (patch) =>
          new Promise((resolve) => {
            releaseFirst = () => resolve(baseSettings(patch))
          })
      )
      .mockImplementationOnce(async (patch) => baseSettings(patch))

    const first = useSettingsStore.getState().saveUpdateSettings({ autoDownload: true })
    const second = useSettingsStore.getState().saveUpdateSettings({ useProxy: false })
    for (
      let attempt = 0;
      attempt < 5 && dbSettings.saveSettings.mock.calls.length === 0;
      attempt++
    ) {
      await Promise.resolve()
    }
    expect(dbSettings.saveSettings).toHaveBeenCalledTimes(1)

    releaseFirst()
    await first
    await second

    expect(dbSettings.saveSettings).toHaveBeenNthCalledWith(1, {
      updates: { ...initialUpdates, autoDownload: true },
    })
    expect(dbSettings.saveSettings).toHaveBeenNthCalledWith(2, {
      updates: { ...initialUpdates, autoDownload: true, useProxy: false },
    })
  })

  it("continues the updater settings queue after a failed write", async () => {
    const initialUpdates = {
      autoCheck: true,
      checkIntervalMinutes: 360,
      autoDownload: false,
      relaunchAfterInstall: true,
      requestTimeoutSeconds: 30,
      useProxy: true,
    }
    useSettingsStore.setState({ settings: baseSettings({ updates: initialUpdates }) })
    dbSettings.saveSettings
      .mockRejectedValueOnce(new Error("db unavailable"))
      .mockImplementationOnce(async (patch) => baseSettings(patch))

    await expect(
      useSettingsStore.getState().saveUpdateSettings({ autoDownload: true })
    ).rejects.toThrow("db unavailable")
    await expect(
      useSettingsStore.getState().saveUpdateSettings({ useProxy: false })
    ).resolves.toBeUndefined()

    expect(dbSettings.saveSettings).toHaveBeenLastCalledWith({
      updates: { ...initialUpdates, useProxy: false },
    })
  })
})

// ---- resetSettings ----

describe("resetSettings", () => {
  it("resets all preferences via save, keeping secrets/identity out of the patch", async () => {
    dbSettings.saveSettings.mockResolvedValue(baseSettings({ theme: "system" }))
    await act(async () => {
      await useSettingsStore.getState().resetSettings()
    })
    const patch = dbSettings.saveSettings.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(patch).not.toHaveProperty("apiKey")
    expect(patch).not.toHaveProperty("apiBaseUrl")
    expect(patch).not.toHaveProperty("id")
    expect(patch).not.toHaveProperty("installUuid")
    expect(patch.theme).toBe("system")
  })

  it("resets just the given keys when scoped", async () => {
    dbSettings.saveSettings.mockResolvedValue(baseSettings({}))
    await act(async () => {
      await useSettingsStore.getState().resetSettings(["theme"])
    })
    expect(dbSettings.saveSettings).toHaveBeenLastCalledWith({ theme: "system" })
  })
})

// ---- setPluginSecurityPosture ----

describe("setPluginSecurityPosture", () => {
  it("persists the posture and writes the result back", async () => {
    const next = baseSettings({ pluginSecurityPosture: "strict" })
    dbSettings.saveSettings.mockResolvedValue(next)
    await act(async () => {
      await useSettingsStore.getState().setPluginSecurityPosture("strict")
    })
    expect(dbSettings.saveSettings).toHaveBeenCalledWith({ pluginSecurityPosture: "strict" })
    expect(useSettingsStore.getState().settings?.pluginSecurityPosture).toBe("strict")
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
        terminalRepl: false,
        lsp: false,
      },
    })
    dbSettings.saveSettings.mockResolvedValue(after)
    await act(async () => {
      await useSettingsStore.getState().setBuiltinToolEnabled("process", true)
    })
    expect(dbSettings.saveSettings).toHaveBeenCalledWith({
      builtinTools: {
        coreFiles: true,
        fileExtras: true,
        git: true,
        process: true,
        environment: true,
        shellAdvanced: false,
        terminalRepl: false,
        lsp: false,
        astGrep: false,
        codeGraph: false,
        dependencyResearch: false,
        webclone: false,
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
        coreFiles: true,
        fileExtras: true,
        git: true,
        process: false,
        environment: true,
        shellAdvanced: true,
        terminalRepl: false,
        lsp: false,
        astGrep: false,
        codeGraph: false,
        dependencyResearch: false,
        webclone: false,
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

// ---- setWebToolsEnabled ----

describe("setWebToolsEnabled", () => {
  beforeEach(() => {
    useSettingsStore.setState({ settings: baseSettings(), loaded: true })
  })

  it("persists the web tools flag and writes the result back", async () => {
    const after = baseSettings({ webTools: { enabled: false } })
    dbSettings.saveSettings.mockResolvedValue(after)
    await act(async () => {
      await useSettingsStore.getState().setWebToolsEnabled(false)
    })
    expect(dbSettings.saveSettings).toHaveBeenCalledWith({ webTools: { enabled: false } })
    expect(useSettingsStore.getState().settings?.webTools?.enabled).toBe(false)
  })

  it("preserves nativeOnAnthropic when toggling enabled", async () => {
    useSettingsStore.setState({
      settings: baseSettings({ webTools: { enabled: true, nativeOnAnthropic: true } }),
      loaded: true,
    })
    dbSettings.saveSettings.mockImplementation(async (patch) => baseSettings(patch))
    await act(async () => {
      await useSettingsStore.getState().setWebToolsEnabled(false)
    })
    expect(dbSettings.saveSettings).toHaveBeenCalledWith({
      webTools: { enabled: false, nativeOnAnthropic: true },
    })
  })
})

// ---- setWebToolsNativeOnAnthropic ----

describe("setWebToolsNativeOnAnthropic", () => {
  beforeEach(() => {
    useSettingsStore.setState({ settings: baseSettings(), loaded: true })
  })

  it("persists the flag while keeping web tools enabled", async () => {
    dbSettings.saveSettings.mockImplementation(async (patch) => baseSettings(patch))
    await act(async () => {
      await useSettingsStore.getState().setWebToolsNativeOnAnthropic(true)
    })
    expect(dbSettings.saveSettings).toHaveBeenCalledWith({
      webTools: { enabled: true, nativeOnAnthropic: true },
    })
    expect(useSettingsStore.getState().settings?.webTools?.nativeOnAnthropic).toBe(true)
  })
})

// ---- setWebToolsAllowPrivateHosts / setWebToolsAlwaysDistill ----

describe("setWebToolsAllowPrivateHosts / setWebToolsAlwaysDistill", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      settings: baseSettings({ webTools: { enabled: true, nativeOnAnthropic: true } }),
      loaded: true,
    })
    dbSettings.saveSettings.mockImplementation(async (patch) => baseSettings(patch))
  })

  it("persists allowPrivateHosts while preserving other web-tools flags", async () => {
    await act(async () => {
      await useSettingsStore.getState().setWebToolsAllowPrivateHosts(true)
    })
    expect(dbSettings.saveSettings).toHaveBeenCalledWith({
      webTools: { enabled: true, nativeOnAnthropic: true, allowPrivateHosts: true },
    })
    expect(useSettingsStore.getState().settings?.webTools?.allowPrivateHosts).toBe(true)
  })

  it("persists alwaysDistill while preserving other web-tools flags", async () => {
    await act(async () => {
      await useSettingsStore.getState().setWebToolsAlwaysDistill(true)
    })
    expect(dbSettings.saveSettings).toHaveBeenCalledWith({
      webTools: { enabled: true, nativeOnAnthropic: true, alwaysDistill: true },
    })
    expect(useSettingsStore.getState().settings?.webTools?.alwaysDistill).toBe(true)
  })
})

// ---- setSkillToolEnabled / setSlashCommandToolEnabled ----

describe("self-invocation tool toggles", () => {
  beforeEach(() => {
    useSettingsStore.setState({ settings: baseSettings(), loaded: true })
    dbSettings.saveSettings.mockImplementation(async (patch) => baseSettings(patch))
  })

  it("persists the Skill tool flag, preserving the other toggle", async () => {
    useSettingsStore.setState({
      settings: baseSettings({ selfInvokeTools: { slashCommand: true } }),
      loaded: true,
    })
    await act(async () => {
      await useSettingsStore.getState().setSkillToolEnabled(true)
    })
    expect(dbSettings.saveSettings).toHaveBeenCalledWith({
      selfInvokeTools: { slashCommand: true, skill: true },
    })
  })

  it("persists the SlashCommand tool flag", async () => {
    await act(async () => {
      await useSettingsStore.getState().setSlashCommandToolEnabled(true)
    })
    expect(dbSettings.saveSettings).toHaveBeenCalledWith({
      selfInvokeTools: { slashCommand: true },
    })
    expect(useSettingsStore.getState().settings?.selfInvokeTools?.slashCommand).toBe(true)
  })

  it("persists the team-collaboration tool flag, preserving other toggles", async () => {
    useSettingsStore.setState({
      settings: baseSettings({ selfInvokeTools: { skill: true } }),
      loaded: true,
    })
    await act(async () => {
      await useSettingsStore.getState().setTeamCollaborationToolEnabled(true)
    })
    expect(dbSettings.saveSettings).toHaveBeenCalledWith({
      selfInvokeTools: { skill: true, teamCollaboration: true },
    })
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

// ---- setProviderConfig / setDefaultProvider — Anthropic sidecar restart ----
//
// Regression coverage for the bug where editing a built-in provider's
// baseURL/apiKey persisted to Dexie and pushed to the Rust ApiKeyState but
// never restarted the sidecar — so the Anthropic native dispatcher (which
// only reads env at process spawn) kept using the stale value indefinitely.

describe("setProviderConfig — anthropic env push + debounced restart", () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it("pushes env and schedules a debounced restart when editing anthropic's baseURL as the default provider", async () => {
    tauri.isTauri.mockReturnValue(true)
    ipc.setProviderEnv.mockResolvedValue(undefined)
    ipc.restartSidecar.mockResolvedValue(undefined)
    useSettingsStore.setState({ settings: baseSettings({ defaultProvider: "anthropic" }) })
    dbSettings.saveSettings.mockImplementation(async (patch) =>
      baseSettings({ defaultProvider: "anthropic", ...patch })
    )

    await act(async () => {
      await useSettingsStore
        .getState()
        .setProviderConfig("anthropic", { baseURL: "https://restart-1.example.com" })
    })

    expect(ipc.setProviderEnv).toHaveBeenCalledWith(null, "https://restart-1.example.com")
    expect(ipc.restartSidecar).not.toHaveBeenCalled()

    jest.advanceTimersByTime(800)

    expect(ipc.restartSidecar).toHaveBeenCalledTimes(1)
  })

  it("coalesces rapid successive edits into a single restart", async () => {
    tauri.isTauri.mockReturnValue(true)
    ipc.setProviderEnv.mockResolvedValue(undefined)
    ipc.restartSidecar.mockResolvedValue(undefined)
    useSettingsStore.setState({ settings: baseSettings({ defaultProvider: "anthropic" }) })
    dbSettings.saveSettings.mockImplementation(async (patch) =>
      baseSettings({ defaultProvider: "anthropic", ...patch })
    )

    await act(async () => {
      await useSettingsStore
        .getState()
        .setProviderConfig("anthropic", { baseURL: "https://coalesce-1.example.com" })
    })
    jest.advanceTimersByTime(400)
    await act(async () => {
      await useSettingsStore
        .getState()
        .setProviderConfig("anthropic", { baseURL: "https://coalesce-2.example.com" })
    })
    jest.advanceTimersByTime(400)
    expect(ipc.restartSidecar).not.toHaveBeenCalled()

    jest.advanceTimersByTime(400)
    expect(ipc.restartSidecar).toHaveBeenCalledTimes(1)
  })

  it("does not schedule an extra restart when the resolved (apiKey, baseURL) pair is unchanged", async () => {
    tauri.isTauri.mockReturnValue(true)
    ipc.setProviderEnv.mockResolvedValue(undefined)
    ipc.restartSidecar.mockResolvedValue(undefined)
    useSettingsStore.setState({ settings: baseSettings({ defaultProvider: "anthropic" }) })
    dbSettings.saveSettings.mockImplementation(async (patch) =>
      baseSettings({ defaultProvider: "anthropic", ...patch })
    )

    await act(async () => {
      await useSettingsStore
        .getState()
        .setProviderConfig("anthropic", { baseURL: "https://dedup.example.com" })
    })
    jest.advanceTimersByTime(800)
    expect(ipc.restartSidecar).toHaveBeenCalledTimes(1)

    await act(async () => {
      await useSettingsStore
        .getState()
        .setProviderConfig("anthropic", { baseURL: "https://dedup.example.com" })
    })
    jest.advanceTimersByTime(800)
    expect(ipc.restartSidecar).toHaveBeenCalledTimes(1)
  })

  it("does not schedule a redundant debounced restart after switching to anthropic when a following edit is identical", async () => {
    tauri.isTauri.mockReturnValue(true)
    ipc.setProviderEnv.mockResolvedValue(undefined)
    ipc.restartSidecar.mockResolvedValue(undefined)
    const anthropicCfg = {
      providerId: "anthropic",
      enabled: true,
      defaultModel: "",
      apiKey: "sk-switch",
      baseURL: "https://switch.example.com",
    }
    dbSettings.saveSettings.mockImplementation(async (patch) =>
      baseSettings({
        defaultProvider: "anthropic",
        providerSettings: { anthropic: anthropicCfg },
        ...patch,
      })
    )

    // Switching the default to anthropic restarts immediately AND records the
    // applied env via markAnthropicEnvApplied.
    await act(async () => {
      await useSettingsStore.getState().setDefaultProvider("anthropic")
    })
    expect(ipc.restartSidecar).toHaveBeenCalledTimes(1)

    // A following config edit with the same (apiKey, baseURL) must NOT schedule
    // a second (debounced) restart — the immediate one already applied it.
    await act(async () => {
      await useSettingsStore.getState().setProviderConfig("anthropic", {
        apiKey: "sk-switch",
        baseURL: "https://switch.example.com",
      })
    })
    jest.advanceTimersByTime(800)
    expect(ipc.restartSidecar).toHaveBeenCalledTimes(1)
  })

  it("does NOT push env or restart for a non-anthropic provider, even as the default", async () => {
    tauri.isTauri.mockReturnValue(true)
    useSettingsStore.setState({ settings: baseSettings({ defaultProvider: "openrouter" }) })
    dbSettings.saveSettings.mockImplementation(async (patch) =>
      baseSettings({ defaultProvider: "openrouter", ...patch })
    )

    await act(async () => {
      await useSettingsStore
        .getState()
        .setProviderConfig("openrouter", { baseURL: "https://openrouter-proxy.example.com" })
    })
    jest.advanceTimersByTime(800)

    expect(ipc.setProviderEnv).not.toHaveBeenCalled()
    expect(ipc.restartSidecar).not.toHaveBeenCalled()
  })

  it("does NOT push env when anthropic is edited but is not the active default provider", async () => {
    tauri.isTauri.mockReturnValue(true)
    useSettingsStore.setState({ settings: baseSettings({ defaultProvider: "openrouter" }) })
    dbSettings.saveSettings.mockImplementation(async (patch) =>
      baseSettings({ defaultProvider: "openrouter", ...patch })
    )

    await act(async () => {
      await useSettingsStore
        .getState()
        .setProviderConfig("anthropic", { baseURL: "https://not-default.example.com" })
    })
    jest.advanceTimersByTime(800)

    expect(ipc.setProviderEnv).not.toHaveBeenCalled()
    expect(ipc.restartSidecar).not.toHaveBeenCalled()
  })

  it("does NOT push env or restart when not in Tauri", async () => {
    tauri.isTauri.mockReturnValue(false)
    useSettingsStore.setState({ settings: baseSettings({ defaultProvider: "anthropic" }) })
    dbSettings.saveSettings.mockImplementation(async (patch) =>
      baseSettings({ defaultProvider: "anthropic", ...patch })
    )

    await act(async () => {
      await useSettingsStore
        .getState()
        .setProviderConfig("anthropic", { baseURL: "https://web-mode.example.com" })
    })
    jest.advanceTimersByTime(800)

    expect(ipc.setProviderEnv).not.toHaveBeenCalled()
    expect(ipc.restartSidecar).not.toHaveBeenCalled()
  })

  it("does NOT push env when the patch touches neither apiKey nor baseURL", async () => {
    tauri.isTauri.mockReturnValue(true)
    useSettingsStore.setState({ settings: baseSettings({ defaultProvider: "anthropic" }) })
    dbSettings.saveSettings.mockImplementation(async (patch) =>
      baseSettings({ defaultProvider: "anthropic", ...patch })
    )

    await act(async () => {
      await useSettingsStore.getState().setProviderConfig("anthropic", { defaultModel: "opus" })
    })
    jest.advanceTimersByTime(800)

    expect(ipc.setProviderEnv).not.toHaveBeenCalled()
    expect(ipc.restartSidecar).not.toHaveBeenCalled()
  })
})

describe("provider mutation persistence", () => {
  it("updates provider UI preferences optimistically while persistence is pending", async () => {
    const initial = baseSettings({
      providerUIPreferences: { statusFilter: "all", sortBy: "name" },
    })
    useSettingsStore.setState({ settings: initial })
    let resolveWrite!: () => void
    dbSettings.saveSettings.mockImplementationOnce(
      (patch) =>
        new Promise((resolve) => {
          resolveWrite = () => resolve(baseSettings({ ...initial, ...patch }))
        })
    )

    const pending = useSettingsStore.getState().setProviderUIPreferences({ statusFilter: "error" })
    await Promise.resolve()
    await Promise.resolve()

    expect(useSettingsStore.getState().providerUIPreferences.statusFilter).toBe("error")

    resolveWrite()
    await pending
  })

  it("rolls back optimistic provider UI preferences when persistence fails", async () => {
    const initial = baseSettings({
      providerUIPreferences: { statusFilter: "all", sortBy: "name" },
    })
    useSettingsStore.setState({ settings: initial })
    dbSettings.saveSettings.mockRejectedValueOnce(new Error("db unavailable"))

    await expect(
      useSettingsStore.getState().setProviderUIPreferences({ statusFilter: "error" })
    ).rejects.toThrow("db unavailable")

    expect(useSettingsStore.getState().providerUIPreferences.statusFilter).toBe("all")
    expect(useSettingsStore.getState().settings?.providerUIPreferences?.statusFilter).toBe("all")
  })

  it("serializes rapid provider patches without losing fields from an earlier write", async () => {
    tauri.isTauri.mockReturnValue(false)
    useSettingsStore.setState({
      settings: baseSettings({
        providerSettings: {
          openai: {
            providerId: "openai",
            enabled: true,
            defaultModel: "gpt-4.1",
          },
        },
      }),
    })

    let releaseFirst!: () => void
    dbSettings.saveSettings
      .mockImplementationOnce(
        (patch) =>
          new Promise((resolve) => {
            releaseFirst = () => resolve(baseSettings(patch))
          })
      )
      .mockImplementationOnce(async (patch) => baseSettings(patch))

    const first = useSettingsStore.getState().setProviderConfig("openai", {
      apiKey: "sk-new",
    })
    const second = useSettingsStore.getState().setProviderConfig("openai", {
      baseURL: "https://proxy.example.com/v1",
    })

    for (
      let attempt = 0;
      attempt < 5 && dbSettings.saveSettings.mock.calls.length === 0;
      attempt++
    ) {
      await Promise.resolve()
    }
    expect(dbSettings.saveSettings).toHaveBeenCalledTimes(1)

    releaseFirst()
    await Promise.all([first, second])

    expect(dbSettings.saveSettings).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        providerSettings: expect.objectContaining({
          openai: expect.objectContaining({
            apiKey: "sk-new",
            baseURL: "https://proxy.example.com/v1",
          }),
        }),
      })
    )
  })

  it("continues the provider mutation queue after a failed write", async () => {
    tauri.isTauri.mockReturnValue(false)
    useSettingsStore.setState({ settings: baseSettings({ providerSettings: {} }) })
    dbSettings.saveSettings
      .mockRejectedValueOnce(new Error("db unavailable"))
      .mockImplementationOnce(async (patch) => baseSettings(patch))

    await expect(
      useSettingsStore.getState().setProviderConfig("openai", { apiKey: "lost" })
    ).rejects.toThrow("db unavailable")
    await expect(
      useSettingsStore.getState().setProviderConfig("openai", { apiKey: "saved" })
    ).resolves.toBeUndefined()

    expect(dbSettings.saveSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        providerSettings: expect.objectContaining({
          openai: expect.objectContaining({ apiKey: "saved" }),
        }),
      })
    )
  })

  it("removes dangling default, routing, and UI references with a custom provider", async () => {
    tauri.isTauri.mockReturnValue(false)
    useSettingsStore.setState({
      settings: baseSettings({
        defaultProvider: "custom-gateway",
        defaultModel: "custom-model",
        providerSettings: {
          openai: {
            providerId: "openai",
            enabled: true,
            defaultModel: "gpt-4.1",
          },
        },
        customProviders: [
          {
            id: "custom-gateway",
            providerId: "custom-gateway",
            isCustom: true,
            name: "Custom Gateway",
            customName: "Custom Gateway",
            baseURL: "https://gateway.example.com/v1",
            apiProtocol: "openai",
            customModels: ["custom-model"],
            models: ["custom-model"],
            defaultModel: "custom-model",
            enabled: true,
          },
        ],
        modelMappings: [
          {
            id: "mixed",
            alias: "balanced",
            providers: [
              { providerId: "custom-gateway", modelId: "custom-model" },
              { providerId: "openai", modelId: "gpt-4.1" },
            ],
            distribution: "priority",
            enabled: true,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        providerUIPreferences: {
          selectedProviderId: "custom-gateway",
          comparisonProviderIds: ["custom-gateway", "openai"],
        },
      }),
    })
    dbSettings.saveSettings.mockImplementation(async (patch) =>
      baseSettings({
        ...useSettingsStore.getState().settings,
        ...patch,
      })
    )

    await useSettingsStore.getState().removeCustomProvider("custom-gateway")

    expect(dbSettings.saveSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        customProviders: [],
        defaultProvider: "openai",
        defaultModel: "gpt-4.1",
        modelMappings: [
          expect.objectContaining({
            providers: [{ providerId: "openai", modelId: "gpt-4.1" }],
          }),
        ],
        providerUIPreferences: expect.objectContaining({
          selectedProviderId: undefined,
          comparisonProviderIds: ["openai"],
        }),
      })
    )
  })
})

describe("setDefaultProvider — anthropic env push + immediate restart", () => {
  it("pushes env and restarts immediately when switching the default provider to anthropic", async () => {
    tauri.isTauri.mockReturnValue(true)
    ipc.setProviderEnv.mockResolvedValue(undefined)
    ipc.restartSidecar.mockResolvedValue(undefined)
    dbSettings.saveSettings.mockImplementation(async (patch) =>
      baseSettings({
        providerSettings: {
          anthropic: {
            providerId: "anthropic",
            enabled: true,
            defaultModel: "",
            apiKey: "sk-anthropic",
            baseURL: "https://proxy.example.com",
          },
        },
        ...patch,
      })
    )

    await act(async () => {
      await useSettingsStore.getState().setDefaultProvider("anthropic")
    })

    expect(ipc.setProviderEnv).toHaveBeenCalledWith("sk-anthropic", "https://proxy.example.com")
    expect(ipc.restartSidecar).toHaveBeenCalledTimes(1)
  })

  it("does NOT push env or restart when switching the default provider to a non-anthropic provider", async () => {
    tauri.isTauri.mockReturnValue(true)
    dbSettings.saveSettings.mockImplementation(async (patch) => baseSettings({ ...patch }))

    await act(async () => {
      await useSettingsStore.getState().setDefaultProvider("openrouter")
    })

    expect(ipc.setProviderEnv).not.toHaveBeenCalled()
    expect(ipc.restartSidecar).not.toHaveBeenCalled()
  })

  it("does NOT push env or restart when not in Tauri", async () => {
    tauri.isTauri.mockReturnValue(false)
    dbSettings.saveSettings.mockImplementation(async (patch) => baseSettings({ ...patch }))

    await act(async () => {
      await useSettingsStore.getState().setDefaultProvider("anthropic")
    })

    expect(ipc.setProviderEnv).not.toHaveBeenCalled()
    expect(ipc.restartSidecar).not.toHaveBeenCalled()
  })

  it("warns when setProviderEnv rejects", async () => {
    tauri.isTauri.mockReturnValue(true)
    ipc.setProviderEnv.mockRejectedValue(new Error("ipc gone"))
    dbSettings.saveSettings.mockImplementation(async (patch) => baseSettings({ ...patch }))

    await act(async () => {
      await useSettingsStore.getState().setDefaultProvider("anthropic")
    })

    expect(console.warn).toHaveBeenCalled()
    expect(ipc.restartSidecar).not.toHaveBeenCalled()
  })
})

// ---- setDefaultProvider — defaultModel pairing ----
//
// Switching the default provider must keep the (defaultModel, defaultProvider)
// pair coherent: a stale model from the previous provider would otherwise be
// sent to the new provider's base URL on the next turn.

describe("setDefaultProvider — defaultModel sync", () => {
  it("rewrites a foreign defaultModel to the new provider's configured default", async () => {
    tauri.isTauri.mockReturnValue(false)
    useSettingsStore.setState({
      settings: baseSettings({
        defaultProvider: "openai",
        defaultModel: "gpt-4o",
        providerSettings: {
          deepseek: { providerId: "deepseek", enabled: true, defaultModel: "deepseek-reasoner" },
        },
      } as never),
    })
    dbSettings.saveSettings.mockImplementation(async (patch) => baseSettings({ ...patch }))

    await act(async () => {
      await useSettingsStore.getState().setDefaultProvider("deepseek")
    })

    expect(dbSettings.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ defaultProvider: "deepseek", defaultModel: "deepseek-reasoner" })
    )
  })

  it("keeps the current defaultModel when the new provider can serve it", async () => {
    tauri.isTauri.mockReturnValue(false)
    useSettingsStore.setState({
      settings: baseSettings({
        defaultProvider: "openai",
        defaultModel: "deepseek-chat",
        providerSettings: {
          deepseek: { providerId: "deepseek", enabled: true, enabledModels: ["deepseek-chat"] },
        },
      } as never),
    })
    dbSettings.saveSettings.mockImplementation(async (patch) => baseSettings({ ...patch }))

    await act(async () => {
      await useSettingsStore.getState().setDefaultProvider("deepseek")
    })

    const patch = dbSettings.saveSettings.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(patch.defaultProvider).toBe("deepseek")
    expect("defaultModel" in patch).toBe(false)
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
    ["setRoutingFallbackEnabled", false, "routingFallbackEnabled"],
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

// ---- Skill bundle mirrors ----

describe("setSkillBundleMirrors", () => {
  it("applies defaults (both on) when no prior value exists", async () => {
    useSettingsStore.setState({ settings: baseSettings(), loaded: true })
    dbSettings.saveSettings.mockResolvedValue(baseSettings())
    await act(async () => {
      await useSettingsStore.getState().setSkillBundleMirrors({ codex: false })
    })
    expect(dbSettings.saveSettings).toHaveBeenCalledWith({
      skillBundleMirrors: { claude: true, codex: false },
    })
  })

  it("merges with existing partial value rather than replacing", async () => {
    useSettingsStore.setState({
      settings: baseSettings({ skillBundleMirrors: { claude: false, codex: true } }),
      loaded: true,
    })
    dbSettings.saveSettings.mockResolvedValue(baseSettings())
    await act(async () => {
      await useSettingsStore.getState().setSkillBundleMirrors({ codex: false })
    })
    expect(dbSettings.saveSettings).toHaveBeenCalledWith({
      skillBundleMirrors: { claude: false, codex: false },
    })
  })
})

describe("resolveSkillBundleMirrors", () => {
  it("returns both-on defaults when settings is null", async () => {
    const { resolveSkillBundleMirrors } = await import("./settings-store")
    expect(resolveSkillBundleMirrors(null)).toEqual({ claude: true, codex: true })
    expect(resolveSkillBundleMirrors(undefined)).toEqual({ claude: true, codex: true })
  })

  it("returns both-on when skillBundleMirrors is missing", async () => {
    const { resolveSkillBundleMirrors } = await import("./settings-store")
    expect(resolveSkillBundleMirrors(baseSettings())).toEqual({ claude: true, codex: true })
  })

  it("preserves user-set false values", async () => {
    const { resolveSkillBundleMirrors } = await import("./settings-store")
    expect(
      resolveSkillBundleMirrors(
        baseSettings({ skillBundleMirrors: { claude: false, codex: false } })
      )
    ).toEqual({ claude: false, codex: false })
  })
})

// ---- Skill panel prefs ----

describe("setSkillPanelPrefs", () => {
  it("persists a partial patch when no prior value exists", async () => {
    useSettingsStore.setState({ settings: baseSettings(), loaded: true })
    dbSettings.saveSettings.mockResolvedValue(baseSettings())
    await act(async () => {
      await useSettingsStore.getState().setSkillPanelPrefs({ density: "compact", viewMode: "grid" })
    })
    expect(dbSettings.saveSettings).toHaveBeenCalledWith({
      skillPanelPrefs: { density: "compact", viewMode: "grid" },
    })
  })

  it("merges over an existing partial rather than replacing it", async () => {
    useSettingsStore.setState({
      settings: baseSettings({ skillPanelPrefs: { density: "compact", showTags: true } }),
      loaded: true,
    })
    dbSettings.saveSettings.mockResolvedValue(baseSettings())
    await act(async () => {
      await useSettingsStore
        .getState()
        .setSkillPanelPrefs({ showTags: false, autoEnableNew: false })
    })
    expect(dbSettings.saveSettings).toHaveBeenCalledWith({
      skillPanelPrefs: { density: "compact", showTags: false, autoEnableNew: false },
    })
  })
})

describe("setLastSkillView", () => {
  it("merges over the existing last-view snapshot", async () => {
    useSettingsStore.setState({
      settings: baseSettings({ lastSkillView: { tab: "browse", sort: "name" } }),
      loaded: true,
    })
    dbSettings.saveSettings.mockResolvedValue(baseSettings())
    await act(async () => {
      await useSettingsStore.getState().setLastSkillView({ sort: "usage", tag: "yaml" })
    })
    expect(dbSettings.saveSettings).toHaveBeenCalledWith({
      lastSkillView: { tab: "browse", sort: "usage", tag: "yaml" },
    })
  })
})

describe("resolveSkillPanelPrefs (re-export)", () => {
  it("applies defaults when settings has no prefs", async () => {
    const { resolveSkillPanelPrefs } = await import("./settings-store")
    const resolved = resolveSkillPanelPrefs(baseSettings().skillPanelPrefs)
    expect(resolved.density).toBe("comfortable")
    expect(resolved.autoEnableNew).toBe(true)
    expect(resolved.showDescription).toBe(true)
  })

  it("honors stored overrides", async () => {
    const { resolveSkillPanelPrefs } = await import("./settings-store")
    const resolved = resolveSkillPanelPrefs({ density: "compact", enabledWarnThreshold: 5 })
    expect(resolved.density).toBe("compact")
    expect(resolved.enabledWarnThreshold).toBe(5)
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

  it("ensureProviderKeys loads once and marks loaded", async () => {
    keyring.loadAllProviderKeys.mockResolvedValue({ openai: "sk-lazy" })
    await act(async () => {
      await useSettingsStore.getState().ensureProviderKeys()
    })
    const s = useSettingsStore.getState()
    expect(s.providerKeys).toEqual({ openai: "sk-lazy" })
    expect(s.providerKeysLoaded).toBe(true)
    expect(keyring.loadAllProviderKeys).toHaveBeenCalledTimes(1)
  })

  it("ensureProviderKeys is idempotent — a second call does not reload", async () => {
    keyring.loadAllProviderKeys.mockResolvedValue({ openai: "sk-lazy" })
    await act(async () => {
      await useSettingsStore.getState().ensureProviderKeys()
      await useSettingsStore.getState().ensureProviderKeys()
    })
    expect(keyring.loadAllProviderKeys).toHaveBeenCalledTimes(1)
  })

  it("ensureProviderKeys warns and stays unloaded on failure, then retries later", async () => {
    keyring.loadAllProviderKeys.mockRejectedValueOnce(new Error("keyring err"))
    await act(async () => {
      await useSettingsStore.getState().ensureProviderKeys()
    })
    expect(useSettingsStore.getState().providerKeys).toEqual({})
    expect(useSettingsStore.getState().providerKeysLoaded).toBe(false)
    expect(console.warn).toHaveBeenCalled()

    // A later call retries because the flag stayed false.
    keyring.loadAllProviderKeys.mockResolvedValue({ openai: "ok" })
    await act(async () => {
      await useSettingsStore.getState().ensureProviderKeys()
    })
    expect(useSettingsStore.getState().providerKeys).toEqual({ openai: "ok" })
    expect(useSettingsStore.getState().providerKeysLoaded).toBe(true)
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

  it("setActivePluginTheme sets the plugin pointer, nulls the custom one, and emits", () => {
    useSettingsStore.setState({ settings: baseSettings({ activeCustomThemeId: "ct-1" }) })
    dbSettings.saveSettings.mockResolvedValue(baseSettings())
    act(() => {
      useSettingsStore.getState().setActivePluginTheme("demo.neon")
    })
    const s = useSettingsStore.getState()
    expect(s.settings?.activePluginThemeId).toBe("demo.neon")
    expect(s.settings?.activeCustomThemeId).toBeNull()
    // Flat projection kept in sync by the `set` wrapper.
    expect(s.activePluginThemeId).toBe("demo.neon")
    expect(dbSettings.saveSettings).toHaveBeenCalledWith({
      activePluginThemeId: "demo.neon",
      activeCustomThemeId: null,
    })
    expect(mockedEmit).toHaveBeenCalledWith(messageBus.SystemEvents.THEME_CHANGED, {
      activePluginThemeId: "demo.neon",
    })
  })

  it("setAccentColor persists the override and emits THEME_CHANGED", async () => {
    useSettingsStore.setState({ settings: baseSettings() })
    dbSettings.saveSettings.mockImplementation(async (p) => baseSettings(p))
    await act(async () => {
      await useSettingsStore.getState().setAccentColor("#ff0000")
    })
    expect(dbSettings.saveSettings).toHaveBeenCalledWith({ accentColor: "#ff0000" })
    expect(useSettingsStore.getState().accentColor).toBe("#ff0000")
    expect(mockedEmit).toHaveBeenCalledWith(messageBus.SystemEvents.THEME_CHANGED, {
      accentColor: "#ff0000",
    })
  })

  it("setAccentColor(null) clears the override", async () => {
    useSettingsStore.setState({ settings: baseSettings({ accentColor: "#ff0000" }) })
    dbSettings.saveSettings.mockImplementation(async (p) => baseSettings(p))
    await act(async () => {
      await useSettingsStore.getState().setAccentColor(null)
    })
    expect(useSettingsStore.getState().accentColor).toBeNull()
  })

  it("setActiveCustomTheme nulls a live plugin theme pointer (mutual exclusion)", () => {
    useSettingsStore.setState({ settings: baseSettings({ activePluginThemeId: "demo.neon" }) })
    dbSettings.saveSettings.mockResolvedValue(baseSettings())
    act(() => {
      useSettingsStore.getState().setActiveCustomTheme("ct-1")
    })
    const s = useSettingsStore.getState()
    expect(s.settings?.activeCustomThemeId).toBe("ct-1")
    expect(s.settings?.activePluginThemeId).toBeNull()
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
  const { repairImportedVscodeThemes } =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
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

// ---- Alias routing actions ----

describe("routing actions", () => {
  const mapping = (id: string, alias: string) => ({
    id,
    alias,
    providers: [{ providerId: "openai", modelId: "gpt-4o" }],
    distribution: "priority" as const,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  })

  beforeEach(() => {
    dbSettings.saveSettings.mockImplementation(async (p: Partial<AppSettings>) =>
      baseSettings({ ...(useSettingsStore.getState().settings ?? {}), ...p })
    )
  })

  it("setRoutingConfig merges the patch over the current (or default) config", async () => {
    useSettingsStore.setState({ settings: baseSettings() })
    await act(async () => {
      await useSettingsStore.getState().setRoutingConfig({ strategy: "cost" })
    })
    expect(dbSettings.saveSettings).toHaveBeenCalledWith({
      routingConfig: expect.objectContaining({ strategy: "cost", maxFallbackAttempts: 3 }),
    })
  })

  it("upsertModelMapping appends a new mapping and stamps updatedAt", async () => {
    useSettingsStore.setState({ settings: baseSettings() })
    await act(async () => {
      await useSettingsStore.getState().upsertModelMapping(mapping("m1", "fast"))
    })
    const saved = dbSettings.saveSettings.mock.calls[0][0].modelMappings
    expect(saved).toHaveLength(1)
    expect(saved[0].alias).toBe("fast")
    expect(saved[0].updatedAt).toBeGreaterThan(1)
  })

  it("upsertModelMapping replaces an existing mapping by id", async () => {
    useSettingsStore.setState({
      settings: baseSettings({ modelMappings: [mapping("m1", "fast"), mapping("m2", "smart")] }),
    })
    await act(async () => {
      await useSettingsStore.getState().upsertModelMapping({ ...mapping("m1", "faster") })
    })
    const saved = dbSettings.saveSettings.mock.calls[0][0].modelMappings
    expect(saved).toHaveLength(2)
    expect(saved.find((m: { id: string }) => m.id === "m1")?.alias).toBe("faster")
  })

  it("removeModelMapping drops by id", async () => {
    useSettingsStore.setState({
      settings: baseSettings({ modelMappings: [mapping("m1", "fast"), mapping("m2", "smart")] }),
    })
    await act(async () => {
      await useSettingsStore.getState().removeModelMapping("m1")
    })
    const saved = dbSettings.saveSettings.mock.calls[0][0].modelMappings
    expect(saved.map((m: { id: string }) => m.id)).toEqual(["m2"])
  })

  it("activateRoutingPreset(merge) snapshots, adapts to enabled providers, and merges by alias", async () => {
    useSettingsStore.setState({
      settings: baseSettings({
        modelMappings: [mapping("m1", "fast"), mapping("m2", "custom-alias")],
        providerSettings: {
          deepseek: { providerId: "deepseek", enabled: true, defaultModel: "" },
          groq: { providerId: "groq", enabled: false, defaultModel: "" },
        },
      }),
    })
    await act(async () => {
      await useSettingsStore.getState().activateRoutingPreset("budget", "merge")
    })
    const saved = dbSettings.saveSettings.mock.calls[0][0]
    // Snapshot captured for revert.
    expect(saved.routingPresets.activePresetId).toBe("preset-budget")
    expect(saved.routingPresets.preActivationSnapshot.mappings).toHaveLength(2)
    // Strategy comes from the preset.
    expect(saved.routingConfig.strategy).toBe("cost")
    // The user's non-preset alias survives a merge; the preset's "fast"
    // replaces the user's "fast".
    const aliases = saved.modelMappings.map((m: { alias: string }) => m.alias)
    expect(aliases).toContain("custom-alias")
    expect(aliases.filter((a: string) => a === "fast")).toHaveLength(1)
    // groq is disabled -> no groq entries survive adaptation (deepseek +
    // always-enabled anthropic remain eligible).
    const providers = saved.modelMappings.flatMap((m: { providers: { providerId: string }[] }) =>
      m.providers.map((p) => p.providerId)
    )
    expect(providers).not.toContain("groq")
  })

  it("activateRoutingPreset(overwrite) replaces the whole mapping list", async () => {
    useSettingsStore.setState({
      settings: baseSettings({
        modelMappings: [mapping("m2", "custom-alias")],
        providerSettings: {
          deepseek: { providerId: "deepseek", enabled: true, defaultModel: "" },
        },
      }),
    })
    await act(async () => {
      await useSettingsStore.getState().activateRoutingPreset("budget", "overwrite")
    })
    const saved = dbSettings.saveSettings.mock.calls[0][0]
    expect(saved.modelMappings.map((m: { alias: string }) => m.alias)).not.toContain("custom-alias")
  })

  it("revertRoutingPreset restores the snapshot and clears activation state", async () => {
    const original = [mapping("m1", "fast")]
    useSettingsStore.setState({
      settings: baseSettings({
        modelMappings: [mapping("p1", "preset-thing")],
        routingPresets: {
          customPresets: [],
          activePresetId: "preset-budget",
          preActivationSnapshot: {
            strategy: "balanced",
            mappings: original,
            routingConfig: {
              strategy: "balanced",
              allowPerRequestOverride: true,
              providerConstraints: [],
              requestTimeoutMs: 30000,
              maxFallbackAttempts: 3,
            },
            timestamp: 1,
          },
        },
      }),
    })
    await act(async () => {
      await useSettingsStore.getState().revertRoutingPreset()
    })
    const saved = dbSettings.saveSettings.mock.calls[0][0]
    expect(saved.modelMappings).toEqual(original)
    expect(saved.routingPresets.activePresetId).toBeNull()
    expect(saved.routingPresets.preActivationSnapshot).toBeNull()
  })

  it("revertRoutingPreset is a no-op without a snapshot", async () => {
    useSettingsStore.setState({ settings: baseSettings() })
    await act(async () => {
      await useSettingsStore.getState().revertRoutingPreset()
    })
    expect(dbSettings.saveSettings).not.toHaveBeenCalled()
  })

  it("activateRoutingPreset is a no-op for an unknown preset id", async () => {
    useSettingsStore.setState({ settings: baseSettings() })
    await act(async () => {
      await useSettingsStore.getState().activateRoutingPreset("nope" as never, "merge")
    })
    expect(dbSettings.saveSettings).not.toHaveBeenCalled()
  })
})

// ---- plugin bus mirroring ----

describe("plugin-facing setters emit on the message bus", () => {
  beforeEach(() => {
    dbSettings.saveSettings.mockResolvedValue(baseSettings())
  })

  it("setTheme emits THEME_CHANGED", async () => {
    await act(async () => {
      await useSettingsStore.getState().setTheme("dark")
    })
    expect(mockedEmit).toHaveBeenCalledWith(messageBus.SystemEvents.THEME_CHANGED, {
      theme: "dark",
    })
  })

  it("setColorTheme emits THEME_CHANGED with the preset", async () => {
    await act(async () => {
      await useSettingsStore.getState().setColorTheme("ocean" as never)
    })
    expect(mockedEmit).toHaveBeenCalledWith(messageBus.SystemEvents.THEME_CHANGED, {
      colorTheme: "ocean",
    })
  })

  it("setLanguage emits SETTINGS_CHANGED", async () => {
    await act(async () => {
      await useSettingsStore.getState().setLanguage("zh-CN" as never)
    })
    expect(mockedEmit).toHaveBeenCalledWith(messageBus.SystemEvents.SETTINGS_CHANGED, {
      language: "zh-CN",
    })
  })
})
