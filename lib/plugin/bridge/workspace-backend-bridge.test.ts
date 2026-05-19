import {
  registerWorkspaceBackendsForPlugin,
  unregisterWorkspaceBackendsForPlugin,
} from "./workspace-backend-bridge"
import {
  __resetWorkspaceBackendRegistryForTesting,
  hasWorkspaceBackend,
} from "@/lib/github/workspace-backend-registry"
import { __resetWorkspaceApiForTesting } from "@/lib/plugin/api/workspace-api"
import type { PluginManifest } from "@/types/plugin/plugin"
import type { E2BBackend, WorkspaceHandle } from "@/lib/github/workspace"

const manifest = (overrides: Partial<PluginManifest>): PluginManifest =>
  ({
    id: "p",
    name: "P",
    version: "1.0.0",
    description: "",
    type: "frontend",
    capabilities: ["tools"],
    main: "index.js",
    ...overrides,
  }) as PluginManifest

const fakeBackend = (): E2BBackend => ({
  clone: jest.fn().mockResolvedValue({
    backend: "e2b",
    path: "/s",
    repoFullName: "o/r",
    branch: "main",
    createdAt: 0,
  } satisfies WorkspaceHandle),
  commitAndPush: jest.fn().mockResolvedValue("sha"),
  remove: jest.fn().mockResolvedValue(true),
})

describe("workspace-backend-bridge", () => {
  beforeEach(() => {
    __resetWorkspaceBackendRegistryForTesting()
    __resetWorkspaceApiForTesting()
  })

  it("registers every entry in manifest.workspaceBackends", async () => {
    const m = manifest({
      workspaceBackends: [{ id: "e2b", label: "E2B", entry: "backend.js", export: "create" }],
    })
    const importer = jest.fn(async () => ({ create: () => fakeBackend() }))
    const result = await registerWorkspaceBackendsForPlugin(m, "/plugins/p", { importer })
    expect(result).toEqual({ registered: 1, errors: [] })
    expect(hasWorkspaceBackend("p:e2b")).toBe(true)
  })

  it("collects errors for invalid factories", async () => {
    const m = manifest({
      workspaceBackends: [{ id: "x", label: "X", entry: "x.js", export: "missing" }],
    })
    const importer = jest.fn(async () => ({ other: () => fakeBackend() }))
    const result = await registerWorkspaceBackendsForPlugin(m, "/plugins/p", { importer })
    expect(result.registered).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]!.message).toMatch(/does not export/i)
  })

  it("rejects backends missing required methods", async () => {
    const m = manifest({
      workspaceBackends: [{ id: "y", label: "Y", entry: "y.js", export: "create" }],
    })
    const importer = jest.fn(async () => ({ create: () => ({ clone: () => {} }) }))
    const result = await registerWorkspaceBackendsForPlugin(m, "/plugins/p", { importer })
    expect(result.errors[0]!.message).toMatch(/invalid WorkspaceProvider/i)
  })

  it("unregister tears down every contributed backend", async () => {
    const m = manifest({
      workspaceBackends: [{ id: "z", label: "Z", entry: "z.js", export: "create" }],
    })
    const importer = jest.fn(async () => ({ create: () => fakeBackend() }))
    await registerWorkspaceBackendsForPlugin(m, "/plugins/p", { importer })
    expect(hasWorkspaceBackend("p:z")).toBe(true)
    unregisterWorkspaceBackendsForPlugin("p")
    expect(hasWorkspaceBackend("p:z")).toBe(false)
  })
})
