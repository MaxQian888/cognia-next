/**
 * Tests for `bootstrapLspRegistry` — verifies the wiring assembles the
 * registry + adapter + unified-LSP sync without touching Tauri.
 */

const syncMock = jest.fn(async (_entries: unknown) => ({ added: 0, removed: 0, skipped: 0 }))
const registryDisposeMock = jest.fn()
const configureLspRegistryMock = jest.fn((_input: unknown) => registryDisposeMock)

jest.mock("./lsp-user-servers", () => ({
  syncUserLspServers: (entries: unknown) => syncMock(entries),
  editorEligibleServers: (resolved: unknown[]) => resolved,
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

jest.mock("@/lib/lsp/resolve-config", () => ({
  resolveLspServers: jest.fn(async () => []),
}))
jest.mock("@/lib/lsp/project-file-reader", () => ({
  readProjectLspFile: jest.fn(async () => null),
}))
jest.mock("@/lib/workspace/roots", () => ({
  primaryRootOf: jest.fn(() => undefined),
}))

const settingsState: { settings: { lsp?: { servers?: unknown[] } } | null } = {
  settings: { lsp: {} },
}
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: {
    getState: () => settingsState,
    subscribe: jest.fn(() => () => {}),
  },
}))

const projectState: { projects: unknown[]; activeProjectId: string | null } = {
  projects: [],
  activeProjectId: null,
}
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: {
    getState: () => projectState,
    subscribe: jest.fn(() => () => {}),
  },
}))

import { __resetLspBootstrapForTesting, bootstrapLspRegistry } from "./lsp-bootstrap"
import type { LspServerConfig } from "@/types/lsp/config"

const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  __resetLspBootstrapForTesting()
  syncMock.mockClear()
  registryDisposeMock.mockClear()
  configureLspRegistryMock.mockClear()
  settingsState.settings = { lsp: {} }
})

describe("bootstrapLspRegistry", () => {
  it("configures the registry with a client and a bridge", () => {
    bootstrapLspRegistry({
      subscribeChanges: () => () => {},
      resolveEditorServers: async () => [],
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

  it("applies the initial resolved editor-server list on bootstrap", async () => {
    const servers: LspServerConfig[] = [
      { id: "eslint", name: "ESLint", languages: ["typescript"], command: "/x" },
    ]
    bootstrapLspRegistry({
      subscribeChanges: () => () => {},
      resolveEditorServers: async () => servers,
    })
    await flush()
    expect(syncMock).toHaveBeenCalledTimes(1)
    expect(syncMock.mock.calls[0][0]).toEqual([expect.objectContaining({ id: "eslint" })])
  })

  it("re-syncs whenever the subscription fires", async () => {
    let listener: (() => void) | null = null
    const dispose = jest.fn()
    bootstrapLspRegistry({
      subscribeChanges: (cb) => {
        listener = cb
        return dispose
      },
      resolveEditorServers: async () => [],
    })
    await flush()
    expect(syncMock).toHaveBeenCalledTimes(1) // initial

    listener!()
    await flush()
    expect(syncMock).toHaveBeenCalledTimes(2)

    listener!()
    await flush()
    expect(syncMock).toHaveBeenCalledTimes(3)
  })

  it("swallows a rejected resolution without throwing", async () => {
    bootstrapLspRegistry({
      subscribeChanges: () => () => {},
      resolveEditorServers: async () => {
        throw new Error("fs blew up")
      },
    })
    await flush()
    expect(syncMock).not.toHaveBeenCalled()
  })

  it("is idempotent — second call returns a disposer that tears the first install down", () => {
    const dispose1 = bootstrapLspRegistry({
      subscribeChanges: () => () => {},
      resolveEditorServers: async () => [],
    })
    const dispose2 = bootstrapLspRegistry({
      subscribeChanges: () => () => {},
      resolveEditorServers: async () => [],
    })
    expect(configureLspRegistryMock).toHaveBeenCalledTimes(1)
    dispose2()
    expect(() => dispose1()).not.toThrow()
  })

  it("dispose tears down the subscription + registry", () => {
    const subscriptionDispose = jest.fn()
    const dispose = bootstrapLspRegistry({
      subscribeChanges: () => subscriptionDispose,
      resolveEditorServers: async () => [],
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
      subscribeChanges: () => () => {},
      resolveEditorServers: async () => [],
    })
    const arg = configureLspRegistryMock.mock.calls[0][0] as { client: unknown; bridge: unknown }
    expect(arg.client).toBe(customClient)
    expect(arg.bridge).toBe(customBridge)
  })
})
