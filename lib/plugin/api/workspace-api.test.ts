import {
  __resetWorkspaceApiForTesting,
  clearWorkspaceBackendsForPluginContext,
  createWorkspaceAPI,
} from "./workspace-api"
import {
  __resetWorkspaceBackendRegistryForTesting,
  hasWorkspaceBackend,
} from "@/lib/github/workspace-backend-registry"

jest.mock("./workspace-root", () => ({ getActiveWorkspaceRoot: jest.fn(() => "/workspace") }))
import type { E2BBackend, WorkspaceHandle } from "@/lib/github/workspace"

function makeBackend(): E2BBackend {
  return {
    clone: jest.fn().mockResolvedValue({
      backend: "e2b",
      path: "/s",
      repoFullName: "org/repo",
      branch: "main",
      createdAt: 0,
    } satisfies WorkspaceHandle),
    commitAndPush: jest.fn().mockResolvedValue("sha"),
    remove: jest.fn().mockResolvedValue(true),
  }
}

describe("createWorkspaceAPI", () => {
  beforeEach(() => {
    __resetWorkspaceApiForTesting()
    __resetWorkspaceBackendRegistryForTesting()
  })

  it("registers a backend with prefixed id", () => {
    const api = createWorkspaceAPI("p")
    const reg = api.registerBackend({ id: "e2b", label: "E2B", backend: makeBackend() })
    expect(reg.backendId).toBe("p:e2b")
    expect(hasWorkspaceBackend("p:e2b")).toBe(true)
  })

  it("returns the host-resolved active workspace root", () => {
    expect(createWorkspaceAPI("p").getActiveRoot()).toBe("/workspace")
  })

  it("getBackend resolves the plugin's own backend by unprefixed id", () => {
    const api = createWorkspaceAPI("p")
    const backend = makeBackend()
    api.registerBackend({ id: "sandbox", label: "Sandbox", backend })
    // Reads back via the unprefixed id — the namespace is applied internally.
    expect(api.getBackend("sandbox")).toBe(backend)
    // A non-existent id (or another plugin's) resolves to undefined.
    expect(api.getBackend("missing")).toBeUndefined()
    expect(createWorkspaceAPI("other").getBackend("sandbox")).toBeUndefined()
  })

  it("rejects duplicate ids from the same plugin", () => {
    const api = createWorkspaceAPI("p")
    api.registerBackend({ id: "x", label: "X", backend: makeBackend() })
    expect(() => api.registerBackend({ id: "x", label: "X2", backend: makeBackend() })).toThrow(
      /already registered/i
    )
  })

  it("unregister removes the backend from the registry", () => {
    const api = createWorkspaceAPI("p")
    const reg = api.registerBackend({ id: "x", label: "X", backend: makeBackend() })
    reg.unregister()
    expect(hasWorkspaceBackend("p:x")).toBe(false)
  })

  it("clearWorkspaceBackendsForPluginContext drops every backend the plugin owns", () => {
    const api = createWorkspaceAPI("p")
    api.registerBackend({ id: "a", label: "A", backend: makeBackend() })
    api.registerBackend({ id: "b", label: "B", backend: makeBackend() })
    expect(api.listRegistered()).toHaveLength(2)
    clearWorkspaceBackendsForPluginContext("p")
    expect(api.listRegistered()).toHaveLength(0)
    expect(hasWorkspaceBackend("p:a")).toBe(false)
    expect(hasWorkspaceBackend("p:b")).toBe(false)
  })
})

describe("workspace consumer surface", () => {
  beforeEach(() => {
    __resetWorkspaceApiForTesting()
    __resetWorkspaceBackendRegistryForTesting()
  })

  it("exposes every consumer method the contract advertises", () => {
    // The contract marks `acquire` as returning a disposable handle, which is
    // what forced `release` to exist: the generator refuses a `returned-handle`
    // effect with no `disposeMethod`, and the first draft of this API had none.
    const api = createWorkspaceAPI("p")
    for (const method of ["acquire", "walk", "read", "changedSince", "release"] as const) {
      expect(typeof api[method]).toBe("function")
    }
  })

  it("refuses a local path when no workspace is open", async () => {
    // The project store is unavailable under the node test env, so
    // `openWorkspaceRoots` yields nothing — and the acquire path must fail
    // closed rather than treating "unknown roots" as "any path allowed".
    const api = createWorkspaceAPI("p")
    await expect(api.acquire({ kind: "local-path", path: "/etc" })).rejects.toThrow(
      /not inside a workspace the user has opened/
    )
    await expect(api.acquire({ kind: "current-project" })).rejects.toThrow(/no workspace is open/)
  })

  it("releasing a non-ephemeral handle never deletes the user's project", async () => {
    const api = createWorkspaceAPI("p")
    await expect(
      api.release({ root: "/home/u/project", origin: "current-project", ephemeral: false })
    ).resolves.toBe(false)
  })
})
