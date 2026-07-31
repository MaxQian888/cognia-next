jest.mock("@cognia/logging", () => ({
  loggers: {
    plugin: {
      child: () => ({
        warn: jest.fn(),
        info: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      }),
    },
  },
}))

const mockTransportCall = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => false),
  transport: { call: (...args: unknown[]) => mockTransportCall(...args) },
}))
jest.mock("@/lib/platform/detect", () => ({ isHeadlessHost: jest.fn(() => false) }))
jest.mock("@/lib/tauri/transport-routing", () => ({
  getActiveRemoteTransport: jest.fn(() => null),
  isRemoteHostActive: jest.fn(() => false),
}))

// Mocked so the DEFAULT (deps-omitted) branch resolves the real dynamic
// imports without pulling Tauri APIs / the heavy monaco graph.
jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn(async () => undefined) }))
jest.mock("@/lib/plugin/core/vscode-loader", () => ({
  ensureDispatcherConfigured: jest.fn(async () => {}),
}))
jest.mock("@/lib/plugin/vscode-shim/rpc-dispatcher", () => ({
  subscribeToVscodeEvents: jest.fn(async () => () => {}),
}))

import { LSP_TAURI_CHANNEL_ID } from "@/lib/plugin/lsp/lsp-client-adapter-tauri"
import {
  ensureEditorLspRuntime,
  __resetEditorLspRuntimeForTesting,
  type EditorLspRuntimeDeps,
} from "./ensure-editor-lsp-runtime"

function makeDeps(overrides: Partial<EditorLspRuntimeDeps> = {}) {
  const invoke = jest.fn(async () => undefined as never)
  const ensureDispatcher = jest.fn(async () => {})
  const subscribe = jest.fn(async () => () => {})
  const hostAvailable = jest.fn(() => true)
  const deps: EditorLspRuntimeDeps = {
    invoke: invoke as EditorLspRuntimeDeps["invoke"],
    ensureDispatcher,
    subscribe,
    hostAvailable,
    ...overrides,
  }
  return { deps, invoke, ensureDispatcher, subscribe, hostAvailable }
}

describe("ensureEditorLspRuntime", () => {
  beforeEach(() => {
    __resetEditorLspRuntimeForTesting()
    mockTransportCall.mockClear()
  })

  it("no-ops off the desktop host and touches nothing", async () => {
    const { deps, invoke, ensureDispatcher, subscribe } = makeDeps({
      hostAvailable: () => false,
    })
    await ensureEditorLspRuntime(deps)
    expect(invoke).not.toHaveBeenCalled()
    expect(ensureDispatcher).not.toHaveBeenCalled()
    expect(subscribe).not.toHaveBeenCalled()
  })

  it("spawns the host, bootstraps the dispatcher, then subscribes — in that order", async () => {
    const { deps, invoke, ensureDispatcher, subscribe } = makeDeps()
    await ensureEditorLspRuntime(deps)

    expect(invoke).toHaveBeenCalledWith("ensure_system_lsp_host")
    expect(ensureDispatcher).toHaveBeenCalledTimes(1)
    expect(subscribe).toHaveBeenCalledWith(LSP_TAURI_CHANNEL_ID)

    // Order: spawn host -> ensureDispatcher -> subscribe.
    const spawnOrder = invoke.mock.invocationCallOrder[0]
    const dispatcherOrder = ensureDispatcher.mock.invocationCallOrder[0]
    const subscribeOrder = subscribe.mock.invocationCallOrder[0]
    expect(spawnOrder).toBeLessThan(dispatcherOrder)
    expect(dispatcherOrder).toBeLessThan(subscribeOrder)
  })

  it("is idempotent — a second call after success does nothing", async () => {
    const { deps, invoke, ensureDispatcher, subscribe } = makeDeps()
    await ensureEditorLspRuntime(deps)
    await ensureEditorLspRuntime(deps)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(ensureDispatcher).toHaveBeenCalledTimes(1)
    expect(subscribe).toHaveBeenCalledTimes(1)
  })

  it("boots each newly active remote execution host exactly once", async () => {
    const hosts = [{}, {}]
    let selected = 0
    const setup = makeDeps({ hostIdentity: () => hosts[selected] })
    await ensureEditorLspRuntime(setup.deps)
    await ensureEditorLspRuntime(setup.deps)
    selected = 1
    await ensureEditorLspRuntime(setup.deps)
    expect(setup.invoke).toHaveBeenCalledTimes(2)
    expect(setup.ensureDispatcher).toHaveBeenCalledTimes(2)
    expect(setup.subscribe).toHaveBeenCalledTimes(2)
  })

  it("uses the confined Companion facade for the active remote host", async () => {
    const setup = makeDeps({ remoteHostActive: () => true })
    await ensureEditorLspRuntime(setup.deps)
    expect(setup.invoke).toHaveBeenCalledWith("lsp_host_ensure")
  })

  it("resets the guard and swallows the error when a step throws", async () => {
    const failing = makeDeps({
      invoke: jest.fn(async () => {
        throw new Error("spawn boom")
      }) as EditorLspRuntimeDeps["invoke"],
    })
    // Does not throw.
    await expect(ensureEditorLspRuntime(failing.deps)).resolves.toBeUndefined()
    expect(failing.ensureDispatcher).not.toHaveBeenCalled()

    // Guard was reset, so a healthy retry proceeds fully.
    const healthy = makeDeps()
    await ensureEditorLspRuntime(healthy.deps)
    expect(healthy.invoke).toHaveBeenCalledWith("ensure_system_lsp_host")
    expect(healthy.ensureDispatcher).toHaveBeenCalledTimes(1)
    expect(healthy.subscribe).toHaveBeenCalledTimes(1)
  })

  it("defaults hostAvailable to isTauri (off-host in jest) and no-ops", async () => {
    // No hostAvailable injected → falls back to isTauri(), which is false in
    // the jest node env, so the runtime stays inert without needing Tauri APIs.
    const invoke = jest.fn(async () => undefined as never)
    await ensureEditorLspRuntime({ invoke: invoke as EditorLspRuntimeDeps["invoke"] })
    expect(invoke).not.toHaveBeenCalled()
  })

  it("resolves the real (mocked) module deps when none are injected", async () => {
    // Only force the host gate on; every other dep falls through the `??` to
    // its dynamic import (mocked at module scope above).
    const loader = await import("@/lib/plugin/core/vscode-loader")
    const dispatcher = await import("@/lib/plugin/vscode-shim/rpc-dispatcher")
    await ensureEditorLspRuntime({ hostAvailable: () => true })
    expect(mockTransportCall).toHaveBeenCalledWith("ensure_system_lsp_host", undefined)
    expect(loader.ensureDispatcherConfigured).toHaveBeenCalledTimes(1)
    expect(dispatcher.subscribeToVscodeEvents).toHaveBeenCalledWith(LSP_TAURI_CHANNEL_ID)
  })

  it("swallows a non-Error throw (stringifies it for the log)", async () => {
    const deps = makeDeps({
      invoke: jest.fn(async () => {
        throw "string boom"
      }) as EditorLspRuntimeDeps["invoke"],
    })
    await expect(ensureEditorLspRuntime(deps.deps)).resolves.toBeUndefined()
    expect(deps.ensureDispatcher).not.toHaveBeenCalled()
  })
})
