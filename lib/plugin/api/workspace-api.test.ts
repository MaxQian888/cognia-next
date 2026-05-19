import {
  __resetWorkspaceApiForTesting,
  clearWorkspaceBackendsForPluginContext,
  createWorkspaceAPI,
} from "./workspace-api"
import {
  __resetWorkspaceBackendRegistryForTesting,
  hasWorkspaceBackend,
} from "@/lib/github/workspace-backend-registry"
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
