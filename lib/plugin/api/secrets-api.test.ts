/**
 * @jest-environment jsdom
 */

jest.mock("@/lib/native/utils", () => ({ isTauri: jest.fn() }))
jest.mock("../core/transport", () => ({ invokePluginApi: jest.fn() }))
jest.mock("@/lib/keyring", () => ({
  getSecret: jest.fn(),
  setSecret: jest.fn(async () => undefined),
  clearSecret: jest.fn(async () => undefined),
  setWebKeyringPassphrase: jest.fn(),
}))
jest.mock("@/lib/data/backup-key", () => ({
  getDefaultBackupPassphrase: jest.fn(async () => "pp"),
}))
jest.mock("../core/logger", () => ({
  loggers: { manager: { warn: jest.fn() } },
  createPluginSystemLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}))

import { isTauri } from "@/lib/native/utils"
import { invokePluginApi } from "../core/transport"
import { getSecret, setSecret, clearSecret, setWebKeyringPassphrase } from "@/lib/keyring"
import {
  createSecretsAPI,
  clearPluginSecrets,
  getSecretsBackendKind,
  __resetSecretListenersForTesting,
} from "./secrets-api"

const mockIsTauri = isTauri as jest.MockedFunction<typeof isTauri>
const mockInvoke = invokePluginApi as jest.MockedFunction<typeof invokePluginApi>
const mockGetSecret = getSecret as jest.MockedFunction<typeof getSecret>
const mockSetSecret = setSecret as jest.MockedFunction<typeof setSecret>
const mockClearSecret = clearSecret as jest.MockedFunction<typeof clearSecret>

beforeEach(() => {
  jest.clearAllMocks()
  localStorage.clear()
  __resetSecretListenersForTesting()
})

describe("createSecretsAPI — Tauri path", () => {
  beforeEach(() => mockIsTauri.mockReturnValue(true))

  it("store routes through the gateway and records the key in the index", async () => {
    const api = createSecretsAPI("p")
    mockInvoke.mockResolvedValue(undefined)
    await api.store("token", "abc")
    expect(mockInvoke).toHaveBeenCalledWith("p", "secrets:set", { key: "token", value: "abc" })
    expect(await api.keys()).toEqual(["token"])
  })

  it("get/has route through the gateway", async () => {
    const api = createSecretsAPI("p")
    mockInvoke.mockResolvedValue("abc")
    expect(await api.get("token")).toBe("abc")
    expect(await api.has("token")).toBe(true)
    mockInvoke.mockResolvedValue(null)
    expect(await api.has("missing")).toBe(false)
  })

  it("delete routes through the gateway and removes the key from the index", async () => {
    const api = createSecretsAPI("p")
    mockInvoke.mockResolvedValue(undefined)
    await api.store("token", "abc")
    await api.delete("token")
    expect(mockInvoke).toHaveBeenCalledWith("p", "secrets:delete", { key: "token" })
    expect(await api.keys()).toEqual([])
  })

  it("does not touch the web keyring on the Tauri path", async () => {
    const api = createSecretsAPI("p")
    mockInvoke.mockResolvedValue(undefined)
    await api.store("k", "v")
    expect(mockSetSecret).not.toHaveBeenCalled()
  })
})

describe("createSecretsAPI — browser path", () => {
  beforeEach(() => mockIsTauri.mockReturnValue(false))

  it("store provisions the web passphrase once and writes via the keyring fallback", async () => {
    const api = createSecretsAPI("p")
    await api.store("token", "abc")
    await api.store("other", "xyz")
    expect(setWebKeyringPassphrase).toHaveBeenCalledTimes(1) // provisioned once
    expect(mockSetSecret).toHaveBeenCalledWith({ namespace: "plugin:p", key: "token" }, "abc")
    expect(await api.keys()).toEqual(["token", "other"])
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("get reads via the keyring fallback under the plugin namespace", async () => {
    const api = createSecretsAPI("p")
    mockGetSecret.mockResolvedValue("abc")
    expect(await api.get("token")).toBe("abc")
    expect(mockGetSecret).toHaveBeenCalledWith({ namespace: "plugin:p", key: "token" })
  })
})

describe("isolation + onDidChange + backend kind", () => {
  beforeEach(() => mockIsTauri.mockReturnValue(true))

  it("namespaces the index per plugin (no cross-plugin leakage)", async () => {
    mockInvoke.mockResolvedValue(undefined)
    const a = createSecretsAPI("a")
    const b = createSecretsAPI("b")
    await a.store("ka", "1")
    await b.store("kb", "2")
    expect(await a.keys()).toEqual(["ka"])
    expect(await b.keys()).toEqual(["kb"])
  })

  it("onDidChange fires on store/delete for this plugin only, and the disposer stops it", async () => {
    mockInvoke.mockResolvedValue(undefined)
    const api = createSecretsAPI("p")
    const other = createSecretsAPI("q")
    const events: string[] = []
    const dispose = api.onDidChange((e) => events.push(e.key))
    await api.store("k1", "v")
    await other.store("k2", "v") // different plugin — ignored
    await api.delete("k1")
    dispose()
    await api.store("k3", "v")
    expect(events).toEqual(["k1", "k1"])
  })

  it("reports os-keyring under Tauri", () => {
    mockIsTauri.mockReturnValue(true)
    expect(getSecretsBackendKind()).toBe("os-keyring")
  })

  it("reports encrypted-web in a browser with IndexedDB", () => {
    mockIsTauri.mockReturnValue(false)
    const g = globalThis as { indexedDB?: unknown }
    const saved = g.indexedDB
    g.indexedDB = saved ?? {}
    expect(getSecretsBackendKind()).toBe("encrypted-web")
    if (saved === undefined) delete g.indexedDB
  })

  it("reports memory when IndexedDB is unavailable", () => {
    mockIsTauri.mockReturnValue(false)
    const g = globalThis as { indexedDB?: unknown }
    const saved = g.indexedDB
    delete g.indexedDB
    expect(getSecretsBackendKind()).toBe("memory")
    if (saved !== undefined) g.indexedDB = saved
  })
})

describe("clearPluginSecrets", () => {
  it("deletes every indexed key and clears the index (Tauri)", async () => {
    mockIsTauri.mockReturnValue(true)
    mockInvoke.mockResolvedValue(undefined)
    const api = createSecretsAPI("p")
    await api.store("a", "1")
    await api.store("b", "2")
    await clearPluginSecrets("p")
    expect(mockInvoke).toHaveBeenCalledWith("p", "secrets:delete", { key: "a" })
    expect(mockInvoke).toHaveBeenCalledWith("p", "secrets:delete", { key: "b" })
    expect(await api.keys()).toEqual([])
  })

  it("deletes via the keyring fallback in the browser", async () => {
    mockIsTauri.mockReturnValue(false)
    const api = createSecretsAPI("p")
    await api.store("a", "1")
    await clearPluginSecrets("p")
    expect(mockClearSecret).toHaveBeenCalledWith({ namespace: "plugin:p", key: "a" })
    expect(await api.keys()).toEqual([])
  })
})
