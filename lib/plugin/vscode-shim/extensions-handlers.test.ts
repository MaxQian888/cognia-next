type Handler = (
  payload: unknown,
  context: { pluginId: string; method: string; requestId: null }
) => unknown
const handlers = new Map<string, Handler>()

jest.mock("./rpc-dispatcher", () => ({
  registerMethod: (method: string, handler: Handler) => {
    handlers.set(method, handler)
    return () => handlers.delete(method)
  },
}))

const mockResume = jest.fn(async () => undefined)
jest.mock("@/lib/plugin/core/manager", () => ({
  getPluginManager: () => ({ resumePlugin: (...args: unknown[]) => mockResume(...(args as [])) }),
}))

import { usePluginStore } from "@/stores/plugin-runtime"
import type { PluginStatus } from "@/types/plugin/plugin"

import {
  __resetVscodeExtensionsForTesting,
  ACTIVATION_WAIT_MS,
  clearVscodeExtensionsForPlugin,
  configureVscodeExtensions,
  createVscodeExtensionsDependencies,
  installVscodeExtensionsHandlers,
  pushVscodeExtensions,
  type InstalledVscodeExtension,
  type VscodeExtensionsDependencies,
} from "./extensions-handlers"

function setup(initial: InstalledVscodeExtension[]) {
  let extensions = initial
  const listeners = new Set<() => void>()
  const sent: Array<[string, string, unknown]> = []
  const deps: VscodeExtensionsDependencies = {
    extensions: () => extensions,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    resume: jest.fn(async () => undefined),
    sendToHost: jest.fn(async (pluginId: string, method: string, payload: unknown) => {
      sent.push([pluginId, method, payload])
      return null
    }),
    hosts: () => ["ext.a", "ext.b"],
  }
  configureVscodeExtensions(deps)
  return {
    deps,
    sent,
    listeners,
    set(next: InstalledVscodeExtension[]) {
      extensions = next
      for (const listener of [...listeners]) listener()
    },
    activate: (id: string, pluginId = "ext.a") =>
      handlers.get("extensions:activate")!(
        { extensionId: pluginId, id },
        { pluginId, method: "extensions:activate", requestId: null }
      ),
    flush: () => new Promise((resolve) => setTimeout(resolve, 0)),
  }
}

const ext = (id: string, status: PluginStatus): InstalledVscodeExtension => ({
  id,
  path: `/plugins/${id}`,
  status,
})

beforeEach(() => {
  handlers.clear()
  __resetVscodeExtensionsForTesting()
  installVscodeExtensionsHandlers()
})

it("tells a host the installed extensions, and again only when they change", async () => {
  const h = setup([ext("ext.a", "enabling"), ext("ext.b", "disabled")])
  await pushVscodeExtensions("ext.a")
  expect(h.sent).toEqual([
    [
      "ext.a",
      "extensions:changed",
      {
        extensions: [
          { id: "ext.a", extensionPath: "/plugins/ext.a", isActive: false },
          { id: "ext.b", extensionPath: "/plugins/ext.b", isActive: false },
        ],
      },
    ],
  ])
  h.set([ext("ext.a", "enabled"), ext("ext.b", "disabled")])
  await h.flush()
  expect(h.sent).toHaveLength(2)
  expect(h.sent[1][0]).toBe("ext.a")
  h.set([ext("ext.a", "enabled"), ext("ext.b", "disabled")])
  await h.flush()
  expect(h.sent).toHaveLength(2)
  clearVscodeExtensionsForPlugin("ext.a")
  h.set([ext("ext.a", "enabled")])
  await h.flush()
  expect(h.sent).toHaveLength(2)
})

describe("Extension.activate on another extension", () => {
  it("answers at once for a running one, case-insensitively, and resumes a suspended one", async () => {
    const h = setup([ext("Acme.Running", "enabled"), ext("acme.idle", "suspended")])
    await expect(h.activate("acme.running")).resolves.toBeNull()
    await expect(h.activate("ACME.IDLE")).resolves.toBeNull()
    expect(h.deps.resume).toHaveBeenCalledWith("acme.idle")
  })

  it("waits for one that is starting", async () => {
    const h = setup([ext("acme.slow", "enabling")])
    const activating = h.activate("acme.slow") as Promise<unknown>
    h.set([ext("acme.slow", "enabled")])
    await expect(activating).resolves.toBeNull()
    expect(h.listeners.size).toBe(1)
  })

  it("fails for one that stops starting, one the user disabled, or one not installed", async () => {
    const h = setup([ext("acme.slow", "enabling"), ext("acme.off", "disabled")])
    const activating = h.activate("acme.slow") as Promise<unknown>
    h.set([ext("acme.slow", "error"), ext("acme.off", "disabled")])
    await expect(activating).rejects.toThrow(/did not start \(error\)/)
    await expect(h.activate("acme.off")).rejects.toThrow(/not enabled/)
    await expect(h.activate("acme.none")).rejects.toThrow(/No VS Code extension/)
    await expect(h.activate("")).rejects.toThrow(/needs an id/)
  })

  it("gives up waiting after the limit", async () => {
    jest.useFakeTimers()
    try {
      const h = setup([ext("acme.stuck", "loading")])
      const activating = h.activate("acme.stuck") as Promise<unknown>
      jest.advanceTimersByTime(ACTIVATION_WAIT_MS)
      await expect(activating).rejects.toThrow(/within 30s/)
    } finally {
      jest.useRealTimers()
    }
  })
})

describe("createVscodeExtensionsDependencies", () => {
  afterEach(() => usePluginStore.setState({ plugins: {} }))

  it("lists VS Code plugins from the store and resumes through the manager", async () => {
    usePluginStore.setState({
      plugins: {
        "acme.a": {
          manifest: { id: "acme.a", type: "vscode-extension" },
          path: "/p/acme.a",
          status: "enabled",
        },
        native: { manifest: { id: "native", type: "frontend" }, path: "/p/n", status: "enabled" },
      } as never,
    })
    const deps = createVscodeExtensionsDependencies({ sendToHost: jest.fn(), hosts: () => [] })
    expect(deps.extensions()).toEqual([{ id: "acme.a", path: "/p/acme.a", status: "enabled" }])
    const listener = jest.fn()
    const stop = deps.subscribe(listener)
    usePluginStore.setState({ plugins: {} })
    stop()
    expect(listener).toHaveBeenCalledTimes(1)
    await deps.resume("acme.a")
    expect(mockResume).toHaveBeenCalledWith("acme.a", "activation")
  })
})
