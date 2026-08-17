import {
  __resetWorkspaceBackendRegistryForTesting,
  clearWorkspaceBackendsForPlugin,
  getWorkspaceBackend,
  hasWorkspaceBackend,
  listWorkspaceBackends,
  registerWorkspaceBackend,
  resolveWorkspaceBackendByKind,
  subscribeWorkspaceBackendRegistry,
  unregisterWorkspaceBackend,
  type WorkspaceBackendRegistryEvent,
} from "./workspace-backend-registry"
import type { E2BBackend, WorkspaceHandle } from "./workspace"

function makeBackend(): E2BBackend {
  return {
    clone: jest.fn().mockResolvedValue({
      backend: "e2b",
      path: "/sandbox",
      repoFullName: "org/repo",
      branch: "main",
      createdAt: Date.now(),
    } satisfies WorkspaceHandle),
    commitAndPush: jest.fn().mockResolvedValue("abc123"),
    remove: jest.fn().mockResolvedValue(true),
  }
}

describe("workspace-backend-registry", () => {
  beforeEach(() => {
    __resetWorkspaceBackendRegistryForTesting()
  })

  it("registers and retrieves a backend by id", () => {
    const backend = makeBackend()
    registerWorkspaceBackend({
      backendId: "test:e2b",
      pluginId: "test",
      label: "Test e2b",
      backend,
    })
    expect(hasWorkspaceBackend("test:e2b")).toBe(true)
    expect(getWorkspaceBackend("test:e2b")).toBe(backend)
  })

  it("rejects duplicate backend ids", () => {
    registerWorkspaceBackend({
      backendId: "dup",
      pluginId: "a",
      label: "x",
      backend: makeBackend(),
    })
    expect(() =>
      registerWorkspaceBackend({
        backendId: "dup",
        pluginId: "b",
        label: "y",
        backend: makeBackend(),
      })
    ).toThrow(/duplicate/i)
  })

  it("unregister is idempotent and reports presence", () => {
    registerWorkspaceBackend({
      backendId: "x",
      pluginId: "p",
      label: "X",
      backend: makeBackend(),
    })
    expect(unregisterWorkspaceBackend("x")).toBe(true)
    expect(unregisterWorkspaceBackend("x")).toBe(false)
  })

  it("clears all backends owned by a plugin", () => {
    registerWorkspaceBackend({
      backendId: "p:a",
      pluginId: "p",
      label: "A",
      backend: makeBackend(),
    })
    registerWorkspaceBackend({
      backendId: "p:b",
      pluginId: "p",
      label: "B",
      backend: makeBackend(),
    })
    registerWorkspaceBackend({
      backendId: "q:c",
      pluginId: "q",
      label: "C",
      backend: makeBackend(),
    })

    clearWorkspaceBackendsForPlugin("p")

    expect(hasWorkspaceBackend("p:a")).toBe(false)
    expect(hasWorkspaceBackend("p:b")).toBe(false)
    expect(hasWorkspaceBackend("q:c")).toBe(true)
  })

  it("notifies subscribers of register/unregister events", () => {
    const events: WorkspaceBackendRegistryEvent[] = []
    const unsubscribe = subscribeWorkspaceBackendRegistry((e) => events.push(e))

    registerWorkspaceBackend({
      backendId: "x",
      pluginId: "p",
      label: "X",
      backend: makeBackend(),
    })
    unregisterWorkspaceBackend("x")
    unsubscribe()

    expect(events).toEqual([
      { type: "register", backendId: "x", pluginId: "p" },
      { type: "unregister", backendId: "x", pluginId: "p" },
    ])
  })

  it("listWorkspaceBackends returns every active registration", () => {
    registerWorkspaceBackend({
      backendId: "a",
      pluginId: "p",
      label: "A",
      backend: makeBackend(),
    })
    registerWorkspaceBackend({
      backendId: "b",
      pluginId: "q",
      label: "B",
      backend: makeBackend(),
    })
    const all = listWorkspaceBackends()
    expect(all.map((r) => r.backendId).sort()).toEqual(["a", "b"])
  })

  describe("resolveWorkspaceBackendByKind", () => {
    it("returns undefined when nothing matches the kind", () => {
      registerWorkspaceBackend({
        backendId: "p:other",
        pluginId: "p",
        label: "x",
        backend: makeBackend(),
      })
      expect(resolveWorkspaceBackendByKind("e2b")).toBeUndefined()
    })

    it("resolves a plugin-prefixed `<pluginId>:<kind>` registration", () => {
      const backend = makeBackend()
      registerWorkspaceBackend({
        backendId: "cognia-e2b-sandbox:e2b",
        pluginId: "cognia-e2b-sandbox",
        label: "E2B",
        backend,
      })
      expect(resolveWorkspaceBackendByKind("e2b")).toBe(backend)
    })

    it("does not match a kind that only appears as a substring", () => {
      registerWorkspaceBackend({
        backendId: "p:e2b-lite",
        pluginId: "p",
        label: "x",
        backend: makeBackend(),
      })
      registerWorkspaceBackend({
        backendId: "p:note2b",
        pluginId: "p",
        label: "x",
        backend: makeBackend(),
      })
      expect(resolveWorkspaceBackendByKind("e2b")).toBeUndefined()
    })

    it("prefers an exact unprefixed id, then the first prefixed match in registration order", () => {
      const first = makeBackend()
      const second = makeBackend()
      const exact = makeBackend()
      registerWorkspaceBackend({ backendId: "a:e2b", pluginId: "a", label: "a", backend: first })
      registerWorkspaceBackend({ backendId: "b:e2b", pluginId: "b", label: "b", backend: second })
      expect(resolveWorkspaceBackendByKind("e2b")).toBe(first)
      registerWorkspaceBackend({ backendId: "e2b", pluginId: "host", label: "h", backend: exact })
      expect(resolveWorkspaceBackendByKind("e2b")).toBe(exact)
      unregisterWorkspaceBackend("e2b")
      unregisterWorkspaceBackend("a:e2b")
      expect(resolveWorkspaceBackendByKind("e2b")).toBe(second)
    })
  })
})
