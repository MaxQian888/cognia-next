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
import { defaultAcquireDeps, type AcquireDeps } from "../workspace/acquire"
import { getPermissionGuard, resetPermissionGuard } from "../security/permission-guard"
import { getPluginConsentBroker, resetPluginConsentBroker } from "../security/consent-broker"

jest.mock("../workspace/acquire", () => {
  const actual = jest.requireActual("../workspace/acquire")
  return { ...actual, defaultAcquireDeps: jest.fn(actual.defaultAcquireDeps) }
})

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
    for (const method of [
      "acquire",
      "walk",
      "read",
      "changedSince",
      "release",
      "snapshot",
      "publish",
    ] as const) {
      expect(typeof api[method]).toBe("function")
    }
  })

  it("requires explicit API permissions before isolated acquisition or publication", () => {
    const api = createWorkspaceAPI("unprivileged")
    const handle = {
      id: "h",
      runId: "run",
      root: "/isolated",
      origin: "bot-run" as const,
      ephemeral: true,
    }
    expect(() =>
      api.acquire({
        kind: "bot-run",
        runId: "run",
        repository: "org/repo",
        ref: "master",
        credentialSlot: "github",
      })
    ).toThrow("filesystem:write")
    expect(() => api.snapshot(handle)).toThrow("filesystem:read")
    expect(() =>
      api.publish(handle, { approvalId: "a", snapshotId: "s", branch: "codex/fix", message: "fix" })
    ).toThrow("filesystem:write")
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

describe("workspace clone authorization", () => {
  let dependencies: AcquireDeps
  let consent: jest.SpyInstance
  const manifest = { permissions: ["git:write" as const], workspaceCloneHosts: ["git.example.com"] }

  beforeEach(() => {
    resetPermissionGuard()
    resetPluginConsentBroker()
    dependencies = {
      openRoots: () => ["/workspace"],
      repoCacheDir: jest.fn(async () => "/cache"),
      removeRepoCache: jest.fn(async () => true),
      clone: jest.fn(async () => "/cache"),
      headOf: jest.fn(async () => null),
    }
    jest.mocked(defaultAcquireDeps).mockReturnValue(dependencies)
    consent = jest.spyOn(getPluginConsentBroker(), "request").mockResolvedValue(true)
  })

  afterEach(() => {
    jest.restoreAllMocks()
    resetPermissionGuard()
    resetPluginConsentBroker()
    jest
      .mocked(defaultAcquireDeps)
      .mockImplementation(jest.requireActual("../workspace/acquire").defaultAcquireDeps)
  })

  it.each([
    { kind: "git-url" as const, url: "https://github.com/o/r.git" },
    { kind: "auto" as const, input: "o/r" },
  ])("requires a declared and currently granted permission for $kind", async (spec) => {
    await expect(createWorkspaceAPI("p", manifest).acquire(spec)).rejects.toThrow("git:write")
    getPermissionGuard().grant("p", "git:write")
    await expect(createWorkspaceAPI("p").acquire(spec)).rejects.toThrow(/declare.*git:write/)
    expect(consent).not.toHaveBeenCalled()
    expect(dependencies.repoCacheDir).not.toHaveBeenCalled()
  })

  it("requires clone-specific consent even at the silent permission tier", async () => {
    getPermissionGuard().grant("p", "git:write")
    consent.mockResolvedValue(false)
    await expect(
      createWorkspaceAPI("p", manifest).acquire({ kind: "auto", input: "o/r" })
    ).rejects.toThrow(/consent/i)
    expect(consent).toHaveBeenCalledWith(
      expect.objectContaining({
        permission: "git:write",
        scope: "workspace-clone:github.com",
        reason: expect.stringContaining("github.com"),
      })
    )
    expect(dependencies.repoCacheDir).not.toHaveBeenCalled()
  })

  it("rechecks permission after consent while using a snapshot of the manifest", async () => {
    getPermissionGuard().grant("p", "git:write")
    consent.mockImplementation(async () => {
      getPermissionGuard().revoke("p", "git:write")
      return true
    })
    await expect(
      createWorkspaceAPI("p", manifest).acquire({ kind: "auto", input: "o/r" })
    ).rejects.toThrow("git:write")
    expect(dependencies.clone).not.toHaveBeenCalled()
  })

  it("allows an approved enterprise host and rejects undeclared caller extensions", async () => {
    getPermissionGuard().grant("p", "git:write")
    const api = createWorkspaceAPI("p", manifest)
    await api.acquire({
      kind: "git-url",
      url: "https://git.example.com/o/r.git",
      allowedHosts: ["git.example.com"],
    })
    expect(dependencies.clone).toHaveBeenCalledWith("https://git.example.com/o/r.git", "/cache", {
      allowedHosts: ["git.example.com"],
    })
    expect(consent).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "workspace-clone:git.example.com" })
    )
    jest.mocked(dependencies.clone).mockClear()
    await expect(
      api.acquire({
        kind: "git-url",
        url: "https://evil.example.com/o/r.git",
        allowedHosts: ["evil.example.com"],
      })
    ).rejects.toThrow(/manifest.*host/i)
    expect(dependencies.clone).not.toHaveBeenCalled()
  })

  it("does not let the plugin mutate its installed host or permission policy", async () => {
    getPermissionGuard().grant("p", "git:write")
    const mutable = { permissions: [] as "git:write"[], workspaceCloneHosts: ["git.example.com"] }
    const api = createWorkspaceAPI("p", mutable)
    mutable.permissions.push("git:write")
    mutable.workspaceCloneHosts.push("evil.example.com")
    await expect(api.acquire({ kind: "auto", input: "o/r" })).rejects.toThrow(/declare.*git:write/)
    await expect(api.acquire({ kind: "auto", input: "evil.example.com/o/r" })).rejects.toThrow(
      /manifest.*host/i
    )
  })

  it("keeps current-project, local-path and local auto acquisitions local", async () => {
    const api = createWorkspaceAPI("p")
    await api.acquire({ kind: "current-project" })
    await api.acquire({ kind: "local-path", path: "/workspace/sub" })
    await api.acquire({ kind: "auto", input: "/workspace/sub" })
    expect(consent).not.toHaveBeenCalled()
    expect(dependencies.clone).not.toHaveBeenCalled()
  })

  it("requires consent before refreshing a default-host cache and honors forbid", async () => {
    const guard = getPermissionGuard()
    guard.grant("p", "git:write")
    const order: string[] = []
    dependencies.headOf = async () => "cached"
    dependencies.remotesOf = async () => [{ name: "origin", url: "https://github.com/o/r.git" }]
    dependencies.fetchAll = jest.fn(async () => {
      order.push("fetch")
    })
    consent.mockImplementation(async () => {
      order.push("consent")
      return true
    })
    const api = createWorkspaceAPI("p", manifest)
    await api.acquire({ kind: "auto", input: "o/r" })
    expect(order).toEqual(["consent", "fetch"])
    expect(dependencies.clone).not.toHaveBeenCalled()
    guard.setTier("p", "git:write", "forbid")
    consent.mockClear()
    jest.mocked(dependencies.fetchAll).mockClear()
    await expect(api.acquire({ kind: "auto", input: "o/r" })).rejects.toThrow("git:write")
    expect(consent).not.toHaveBeenCalled()
    expect(dependencies.fetchAll).not.toHaveBeenCalled()
  })
})
