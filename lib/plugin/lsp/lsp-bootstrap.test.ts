/**
 * Tests for `bootstrapLspRegistry` — verifies the wiring assembles
 * the registry + adapter + settings sync without touching Tauri.
 */

const syncMock = jest.fn(async () => ({ added: 0, removed: 0, skipped: 0 }))
const registryDisposeMock = jest.fn()
const configureLspRegistryMock = jest.fn(() => registryDisposeMock)

jest.mock("./lsp-user-servers", () => ({
  syncUserLspServers: (entries: unknown) => syncMock(entries),
}))

jest.mock("./lsp-registry", () => ({
  configureLspRegistry: (input: unknown) => configureLspRegistryMock(input),
}))

jest.mock("./lsp-client-adapter-tauri", () => {
  return {
    LSP_TAURI_CHANNEL_ID: "cognia.lsp-service",
    TauriLspClientAdapter: jest.fn().mockImplementation(() => ({
      install: jest.fn(),
      start: jest.fn(),
      stop: jest.fn(),
    })),
  }
})

jest.mock("@/lib/plugin/vscode-shim/monaco-bridge", () => ({
  setDiagnostics: jest.fn(),
}))

jest.mock("@/lib/plugin/vscode-shim/lsp-workspace-manager", () => ({
  listWorkspaceFolders: jest.fn(() => []),
}))

const settingsState: {
  settings: { developer?: { userLspServers?: unknown[] } } | null
} = { settings: { developer: {} } }

jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: {
    getState: () => settingsState,
    subscribe: jest.fn(),
  },
}))

import { __resetLspBootstrapForTesting, bootstrapLspRegistry } from "./lsp-bootstrap"

beforeEach(() => {
  __resetLspBootstrapForTesting()
  syncMock.mockClear()
  registryDisposeMock.mockClear()
  configureLspRegistryMock.mockClear()
  settingsState.settings = { developer: {} }
})

describe("bootstrapLspRegistry", () => {
  it("configures the registry with a client and a bridge", () => {
    bootstrapLspRegistry({
      subscribeUserLspServers: () => () => {},
      getUserLspServers: () => undefined,
    })
    expect(configureLspRegistryMock).toHaveBeenCalledTimes(1)
    const arg = configureLspRegistryMock.mock.calls[0][0] as {
      client: unknown
      bridge: unknown
      resolveWorkspaceFolders: () => unknown[]
    }
    expect(arg.client).toBeDefined()
    expect(arg.bridge).toBeDefined()
    expect(typeof arg.resolveWorkspaceFolders).toBe("function")
  })

  it("applies the initial user-LSP snapshot on bootstrap", () => {
    bootstrapLspRegistry({
      subscribeUserLspServers: () => () => {},
      getUserLspServers: () => [
        {
          id: "eslint",
          name: "ESLint",
          languages: ["typescript"],
          command: "/x",
          enabled: true,
        },
      ],
    })
    expect(syncMock).toHaveBeenCalledTimes(1)
    expect(syncMock.mock.calls[0][0]).toEqual([
      expect.objectContaining({ id: "eslint", name: "ESLint" }),
    ])
  })

  it("re-syncs whenever the subscription fires", () => {
    let listener: ((entries: unknown[] | undefined) => void) | null = null
    const dispose = jest.fn()
    bootstrapLspRegistry({
      subscribeUserLspServers: (cb) => {
        listener = cb
        return dispose
      },
      getUserLspServers: () => undefined,
    })
    expect(syncMock).toHaveBeenCalledTimes(1) // initial empty

    // Fire a change.
    listener!([
      { id: "pyright", name: "Pyright", languages: ["python"], command: "/p", enabled: true },
    ])
    expect(syncMock).toHaveBeenCalledTimes(2)

    // And another.
    listener!([])
    expect(syncMock).toHaveBeenCalledTimes(3)
  })

  it("is idempotent — second call returns a disposer that tears the first install down", () => {
    const dispose1 = bootstrapLspRegistry({
      subscribeUserLspServers: () => () => {},
      getUserLspServers: () => undefined,
    })
    const dispose2 = bootstrapLspRegistry({
      subscribeUserLspServers: () => () => {},
      getUserLspServers: () => undefined,
    })
    // configureLspRegistry should still only have been called once.
    expect(configureLspRegistryMock).toHaveBeenCalledTimes(1)
    // Both disposers should clean up the same install.
    dispose2()
    // Disposer is idempotent — a second dispose call should not throw.
    expect(() => dispose1()).not.toThrow()
  })

  it("dispose tears down the subscription + registry", () => {
    const subscriptionDispose = jest.fn()
    const dispose = bootstrapLspRegistry({
      subscribeUserLspServers: () => subscriptionDispose,
      getUserLspServers: () => undefined,
    })
    dispose()
    expect(subscriptionDispose).toHaveBeenCalled()
    expect(registryDisposeMock).toHaveBeenCalled()
  })

  it("test-provided client + bridge are used directly (no Tauri adapter constructed)", () => {
    const customClient = { start: jest.fn(), stop: jest.fn() }
    const customBridge = { setDiagnostics: jest.fn() }
    bootstrapLspRegistry({
      client: customClient,
      bridge: customBridge,
      subscribeUserLspServers: () => () => {},
      getUserLspServers: () => undefined,
    })
    const arg = configureLspRegistryMock.mock.calls[0][0] as {
      client: unknown
      bridge: unknown
    }
    expect(arg.client).toBe(customClient)
    expect(arg.bridge).toBe(customBridge)
  })
})
