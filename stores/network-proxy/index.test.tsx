/**
 * @jest-environment jsdom
 */

import { render } from "@testing-library/react"
import { DEFAULT_NETWORK_PROXY_SETTINGS } from "@/types/network/proxy"

jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(),
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const tauriCore = require("@tauri-apps/api/core") as { invoke: jest.Mock }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tauri = require("@/lib/tauri") as { isTauri: jest.Mock }

const { useSettingsStore } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("@/stores/settings/settings-store") as typeof import("@/stores/settings/settings-store")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const proxyStore = require("./index") as typeof import("./index")

const baseSettings = (np: Partial<typeof DEFAULT_NETWORK_PROXY_SETTINGS> = {}) => ({
  id: "singleton" as const,
  permissionMode: "default" as const,
  alwaysAllowTools: [],
  builtinTools: {
    fileExtras: true,
    git: true,
    process: false,
    environment: true,
    shellAdvanced: false,
  },
  networkProxy: { ...DEFAULT_NETWORK_PROXY_SETTINGS, ...np },
})

beforeEach(() => {
  jest.clearAllMocks()
  jest.spyOn(console, "warn").mockImplementation(() => {})
  jest.spyOn(console, "debug").mockImplementation(() => {})
  useSettingsStore.setState({ settings: null, loaded: false, providerKeys: {} })
  proxyStore.resetApplyProxyDedupeForTesting()
})

afterEach(() => {
  // `clearMocks: true` (jest.config.ts:16) only clears call history. Without this teardown
  // the console.warn / console.debug spies installed in beforeEach leak into other suites
  // running in the same Jest worker — the pattern mirrors stores/settings/settings-store.test.ts:80-82.
  jest.restoreAllMocks()
})

describe("useProxyStore (legacy shape)", () => {
  it("reports disabled when no settings are loaded", () => {
    const state = proxyStore.useProxyStore.getState()
    expect(state.config.enabled).toBe(false)
    expect(state.config.mode).toBe("off")
    expect(state.config.url).toBeNull()
  })

  it("reports manual mode + url when host/port populated", () => {
    useSettingsStore.setState({
      settings: baseSettings({ mode: "manual", host: "127.0.0.1", port: 7890 }),
      loaded: true,
      providerKeys: {},
    })
    const state = proxyStore.useProxyStore.getState()
    expect(state.config.enabled).toBe(true)
    expect(state.config.mode).toBe("manual")
    expect(state.config.url).toBe("http://127.0.0.1:7890")
  })

  it("preserves manual auth credentials when both are set", () => {
    useSettingsStore.setState({
      settings: baseSettings({
        mode: "manual",
        host: "proxy.corp",
        port: 8080,
        username: "alice",
        password: "secret",
      }),
      loaded: true,
      providerKeys: {},
    })
    const state = proxyStore.useProxyStore.getState()
    expect(state.config.manual).toEqual({ username: "alice", password: "secret" })
  })

  it("returns null manual when only one cred is present", () => {
    useSettingsStore.setState({
      settings: baseSettings({
        mode: "manual",
        host: "proxy.corp",
        port: 8080,
        username: "alice",
      }),
      loaded: true,
      providerKeys: {},
    })
    const state = proxyStore.useProxyStore.getState()
    expect(state.config.manual).toBeNull()
  })

  it("subscribe fires when networkProxy changes", () => {
    const listener = jest.fn()
    const unsub = proxyStore.useProxyStore.subscribe(listener)
    useSettingsStore.setState({
      settings: baseSettings({ mode: "manual", host: "127.0.0.1", port: 7890 }),
      loaded: true,
      providerKeys: {},
    })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0].config.url).toBe("http://127.0.0.1:7890")
    unsub()
  })

  it("subscribe does NOT fire when an unrelated field changes", () => {
    useSettingsStore.setState({
      settings: baseSettings({ mode: "manual", host: "127.0.0.1", port: 7890 }),
      loaded: true,
      providerKeys: {},
    })
    const listener = jest.fn()
    const unsub = proxyStore.useProxyStore.subscribe(listener)
    useSettingsStore.setState((prev) => ({
      ...prev,
      settings: { ...prev.settings!, theme: "dark" },
    }))
    expect(listener).not.toHaveBeenCalled()
    unsub()
  })

  it("calling useProxyStore() directly returns the current snapshot", () => {
    useSettingsStore.setState({
      settings: baseSettings({ mode: "manual", host: "1.1.1.1", port: 5555 }),
      loaded: true,
      providerKeys: {},
    })
    const state = proxyStore.useProxyStore()
    expect(state.config.url).toBe("http://1.1.1.1:5555")
  })
})

describe("getActiveProxyUrl", () => {
  it("returns null when disabled", () => {
    expect(proxyStore.getActiveProxyUrl()).toBeNull()
  })

  it("returns the url when active", () => {
    useSettingsStore.setState({
      settings: baseSettings({ mode: "manual", host: "127.0.0.1", port: 7890 }),
      loaded: true,
      providerKeys: {},
    })
    expect(proxyStore.getActiveProxyUrl()).toBe("http://127.0.0.1:7890")
  })

  it("accepts an explicit snapshot", () => {
    const snap = { config: { enabled: true, mode: "manual" as const, url: "http://x:1" } }
    expect(proxyStore.getActiveProxyUrl(snap)).toBe("http://x:1")
  })
})

describe("getNetworkProxy", () => {
  it("returns defaults when settings are unloaded", () => {
    expect(proxyStore.getNetworkProxy()).toEqual(DEFAULT_NETWORK_PROXY_SETTINGS)
  })

  it("returns the persisted networkProxy", () => {
    useSettingsStore.setState({
      settings: baseSettings({ mode: "manual", host: "10.0.0.1", port: 1080 }),
      loaded: true,
      providerKeys: {},
    })
    expect(proxyStore.getNetworkProxy().host).toBe("10.0.0.1")
    expect(proxyStore.getNetworkProxy().port).toBe(1080)
  })
})

describe("applyProxyToRust", () => {
  it("is a no-op outside Tauri", async () => {
    tauri.isTauri.mockReturnValue(false)
    await proxyStore.applyProxyToRust()
    expect(tauriCore.invoke).not.toHaveBeenCalled()
  })

  it("invokes proxy_set with the snake_case payload in Tauri", async () => {
    tauri.isTauri.mockReturnValue(true)
    tauriCore.invoke.mockResolvedValue(undefined)
    useSettingsStore.setState({
      settings: baseSettings({
        mode: "manual",
        host: "127.0.0.1",
        port: 7890,
        username: "alice",
        password: "secret",
      }),
      loaded: true,
      providerKeys: {},
    })
    await proxyStore.applyProxyToRust()
    expect(tauriCore.invoke).toHaveBeenCalledWith("proxy_set", {
      cfg: expect.objectContaining({
        mode: "manual",
        protocol: "http",
        host: "127.0.0.1",
        port: 7890,
        username: "alice",
        password: "secret",
        proxy_websockets: true,
      }),
    })
  })

  it("dedupes consecutive identical pushes", async () => {
    tauri.isTauri.mockReturnValue(true)
    tauriCore.invoke.mockResolvedValue(undefined)
    useSettingsStore.setState({
      settings: baseSettings({ mode: "manual", host: "127.0.0.1", port: 7890 }),
      loaded: true,
      providerKeys: {},
    })
    await proxyStore.applyProxyToRust()
    await proxyStore.applyProxyToRust()
    expect(tauriCore.invoke).toHaveBeenCalledTimes(1)
  })

  it("re-pushes when config changes", async () => {
    tauri.isTauri.mockReturnValue(true)
    tauriCore.invoke.mockResolvedValue(undefined)
    useSettingsStore.setState({
      settings: baseSettings({ mode: "manual", host: "127.0.0.1", port: 7890 }),
      loaded: true,
      providerKeys: {},
    })
    await proxyStore.applyProxyToRust()
    useSettingsStore.setState({
      settings: baseSettings({ mode: "manual", host: "10.0.0.1", port: 7890 }),
      loaded: true,
      providerKeys: {},
    })
    await proxyStore.applyProxyToRust()
    expect(tauriCore.invoke).toHaveBeenCalledTimes(2)
  })

  it("swallows errors so the caller never throws", async () => {
    tauri.isTauri.mockReturnValue(true)
    tauriCore.invoke.mockRejectedValue(new Error("boom"))
    await expect(proxyStore.applyProxyToRust()).resolves.toBeUndefined()
  })

  it("logs the empty-config branch when proxy is inactive but Tauri is on", async () => {
    tauri.isTauri.mockReturnValue(true)
    tauriCore.invoke.mockResolvedValue(undefined)
    // No host/port — `isProxyActive` returns false but we still push to Rust.
    useSettingsStore.setState({
      settings: baseSettings({ mode: "off" }),
      loaded: true,
      providerKeys: {},
    })
    await proxyStore.applyProxyToRust()
    expect(tauriCore.invoke).toHaveBeenCalledWith(
      "proxy_set",
      expect.objectContaining({ cfg: expect.objectContaining({ mode: "off" }) })
    )
  })

  it("explicit cfg argument overrides the live settings snapshot", async () => {
    tauri.isTauri.mockReturnValue(true)
    tauriCore.invoke.mockResolvedValue(undefined)
    // Live settings are off; the explicit cfg should still be sent.
    useSettingsStore.setState({
      settings: baseSettings({ mode: "off" }),
      loaded: true,
      providerKeys: {},
    })
    await proxyStore.applyProxyToRust({
      ...DEFAULT_NETWORK_PROXY_SETTINGS,
      mode: "manual",
      host: "10.10.10.10",
      port: 8888,
    })
    expect(tauriCore.invoke).toHaveBeenCalledWith(
      "proxy_set",
      expect.objectContaining({
        cfg: expect.objectContaining({ host: "10.10.10.10", port: 8888 }),
      })
    )
  })
})

describe("maybeAutoDetectProxy", () => {
  it("is a no-op outside Tauri", async () => {
    tauri.isTauri.mockReturnValue(false)
    await proxyStore.maybeAutoDetectProxy()
    expect(tauriCore.invoke).not.toHaveBeenCalled()
  })

  it("is a no-op when mode is not auto", async () => {
    tauri.isTauri.mockReturnValue(true)
    useSettingsStore.setState({
      settings: baseSettings({ mode: "manual", host: "127.0.0.1", port: 7890 }),
      loaded: true,
      providerKeys: {},
    })
    await proxyStore.maybeAutoDetectProxy()
    expect(tauriCore.invoke).not.toHaveBeenCalled()
  })

  it("adopts the top candidate when it differs from the stored host/port", async () => {
    tauri.isTauri.mockReturnValue(true)
    const saveSpy = jest.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      settings: baseSettings({ mode: "auto", host: "127.0.0.1", port: 1111 }),
      loaded: true,
      providerKeys: {},
      save: saveSpy,
    })
    tauriCore.invoke.mockResolvedValue([
      { kind: "socks5", host: "127.0.0.1", port: 1080, label: "SOCKS @ 1080" },
    ])
    await proxyStore.maybeAutoDetectProxy()
    expect(tauriCore.invoke).toHaveBeenCalledWith("proxy_detect")
    expect(saveSpy).toHaveBeenCalled()
    const patch = saveSpy.mock.calls[0][0]
    expect(patch.networkProxy.host).toBe("127.0.0.1")
    expect(patch.networkProxy.port).toBe(1080)
    expect(patch.networkProxy.protocol).toBe("socks5")
    expect(patch.networkProxy.mode).toBe("auto")
  })

  it("does not re-save when the top candidate matches the stored host/port", async () => {
    tauri.isTauri.mockReturnValue(true)
    const saveSpy = jest.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      settings: baseSettings({ mode: "auto", host: "127.0.0.1", port: 7890 }),
      loaded: true,
      providerKeys: {},
      save: saveSpy,
    })
    tauriCore.invoke.mockResolvedValue([
      { kind: "http", host: "127.0.0.1", port: 7890, label: "HTTP @ 7890" },
    ])
    await proxyStore.maybeAutoDetectProxy()
    expect(saveSpy).not.toHaveBeenCalled()
  })

  it("leaves the config untouched when detection finds nothing", async () => {
    tauri.isTauri.mockReturnValue(true)
    const saveSpy = jest.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      settings: baseSettings({ mode: "auto", host: "1.2.3.4", port: 9 }),
      loaded: true,
      providerKeys: {},
      save: saveSpy,
    })
    tauriCore.invoke.mockResolvedValue([])
    await proxyStore.maybeAutoDetectProxy()
    expect(saveSpy).not.toHaveBeenCalled()
  })

  it("swallows detection errors so the caller never throws", async () => {
    tauri.isTauri.mockReturnValue(true)
    useSettingsStore.setState({
      settings: baseSettings({ mode: "auto" }),
      loaded: true,
      providerKeys: {},
    })
    tauriCore.invoke.mockRejectedValue(new Error("boom"))
    await expect(proxyStore.maybeAutoDetectProxy()).resolves.toBeUndefined()
  })
})

describe("useNetworkProxy hook", () => {
  function HookProbe({ onValue }: { onValue: (v: unknown) => void }) {
    const value = proxyStore.useNetworkProxy()
    onValue(value)
    return null
  }

  it("returns DEFAULT_NETWORK_PROXY_SETTINGS when settings are not loaded", () => {
    const seen: unknown[] = []
    render(<HookProbe onValue={(v) => seen.push(v)} />)
    expect(seen[0]).toEqual(DEFAULT_NETWORK_PROXY_SETTINGS)
  })

  it("returns the persisted networkProxy when settings are loaded", () => {
    useSettingsStore.setState({
      settings: baseSettings({ mode: "manual", host: "1.2.3.4", port: 9999 }),
      loaded: true,
      providerKeys: {},
    })
    const seen: unknown[] = []
    render(<HookProbe onValue={(v) => seen.push(v)} />)
    expect(seen[0]).toMatchObject({ host: "1.2.3.4", port: 9999 })
  })
})
