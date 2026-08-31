jest.mock("@/lib/tauri", () => ({
  transport: { call: jest.fn() },
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { transport } = require("@/lib/tauri") as { transport: { call: jest.Mock } }
const call = transport.call

import {
  __resetWorkspaceHandleBackendsForTesting,
  cloneToWorkspace,
  commitAndPush,
  removeWorkspace,
  statWorkspace,
  type E2BBackend,
  type WorkspaceHandle,
} from "./workspace"
import {
  __resetWorkspaceBackendRegistryForTesting,
  registerWorkspaceBackend,
  unregisterWorkspaceBackend,
} from "./workspace-backend-registry"

/**
 * Register a backend the way the real plugin does — under the plugin-prefixed
 * id — so these tests exercise the kind-based resolution the host relies on.
 */
function registerPluginE2B(backend: E2BBackend, pluginId = "cognia-e2b-sandbox"): void {
  registerWorkspaceBackend({
    backendId: `${pluginId}:e2b`,
    pluginId,
    label: "E2B Firecracker",
    backend,
  })
}

beforeEach(() => {
  call.mockReset()
  __resetWorkspaceBackendRegistryForTesting()
  __resetWorkspaceHandleBackendsForTesting()
})

describe("cloneToWorkspace — local backend", () => {
  it("invokes github_workspace_clone and synthesizes a WorkspaceHandle", async () => {
    call.mockResolvedValueOnce({ path: "/tmp/ws/octocat_hello-world/abc", createdAt: 123 })
    const handle = await cloneToWorkspace({
      repoFullName: "octocat/hello-world",
      branch: "main",
      token: "x",
      backend: "local",
      baseDir: "/tmp/ws",
    })
    expect(call).toHaveBeenCalledWith("github_workspace_clone", {
      args: {
        repoFullName: "octocat/hello-world",
        branch: "main",
        token: "x",
        baseDir: "/tmp/ws",
      },
    })
    expect(handle).toEqual({
      backend: "local",
      path: "/tmp/ws/octocat_hello-world/abc",
      repoFullName: "octocat/hello-world",
      branch: "main",
      baseBranch: undefined,
      createdAt: 123,
    })
  })

  it("forwards baseDir undefined when not supplied", async () => {
    call.mockResolvedValueOnce({ path: "/some/path", createdAt: 0 })
    await cloneToWorkspace({
      repoFullName: "o/r",
      branch: "main",
      token: "tok",
      backend: "local",
    })
    expect(call).toHaveBeenCalledWith("github_workspace_clone", {
      args: { repoFullName: "o/r", branch: "main", token: "tok", baseDir: undefined },
    })
  })

  it("clones a base branch and checks out an isolated target branch", async () => {
    call.mockResolvedValueOnce({ path: "/some/path", createdAt: 0 })
    await cloneToWorkspace({
      repoFullName: "o/r",
      branch: "cognia/issue-42",
      baseBranch: "main",
      token: "tok",
      backend: "local",
    })
    expect(call).toHaveBeenCalledWith("github_workspace_clone", {
      args: {
        repoFullName: "o/r",
        branch: "cognia/issue-42",
        baseBranch: "main",
        token: "tok",
        baseDir: undefined,
      },
    })
  })

  it("propagates a Rust-side clone failure", async () => {
    call.mockRejectedValueOnce("git clone failed: branch not found")
    await expect(
      cloneToWorkspace({
        repoFullName: "o/r",
        branch: "main",
        token: "x",
        backend: "local",
      })
    ).rejects.toMatch(/git clone failed/)
  })

  it("throws for the e2b backend when no backend is registered", async () => {
    await expect(
      cloneToWorkspace({
        repoFullName: "o/r",
        branch: "main",
        token: "x",
        backend: "e2b",
      })
    ).rejects.toThrow(/e2b workspace backend not registered/)
    expect(call).not.toHaveBeenCalled()
  })

  it("delegates to the registered E2B backend when one is set", async () => {
    const backend: E2BBackend = {
      clone: jest.fn(async () => ({
        backend: "e2b" as const,
        path: "sb-id-1",
        repoFullName: "o/r",
        branch: "main",
        createdAt: 0,
      })),
      commitAndPush: jest.fn(),
      remove: jest.fn(async () => true),
    }
    registerPluginE2B(backend)
    const handle = await cloneToWorkspace({
      repoFullName: "o/r",
      branch: "main",
      token: "tok",
      backend: "e2b",
    })
    expect(handle.path).toBe("sb-id-1")
    expect(backend.clone).toHaveBeenCalledWith({
      repoFullName: "o/r",
      branch: "main",
      token: "tok",
    })
    expect(call).not.toHaveBeenCalled()
  })
})

describe("commitAndPush", () => {
  const handle: WorkspaceHandle = {
    backend: "local",
    path: "/tmp/ws/o_r/abc",
    repoFullName: "o/r",
    branch: "feat/x",
    createdAt: 0,
  }

  it("invokes github_workspace_commit_and_push and returns the SHA", async () => {
    call.mockResolvedValueOnce("deadbeef\n")
    const sha = await commitAndPush({ workspace: handle, message: "Cognia: do the thing" })
    expect(sha).toBe("deadbeef\n")
    expect(call).toHaveBeenCalledWith("github_workspace_commit_and_push", {
      args: {
        workspacePath: handle.path,
        repoFullName: "o/r",
        branch: "feat/x",
        baseBranch: undefined,
        message: "Cognia: do the thing",
        remoteBranch: undefined,
        token: undefined,
      },
    })
  })

  it("forwards remoteBranch when supplied", async () => {
    call.mockResolvedValueOnce("sha")
    await commitAndPush({
      workspace: handle,
      message: "x",
      remoteBranch: "cognia/issue-5",
    })
    expect(call).toHaveBeenCalledWith("github_workspace_commit_and_push", {
      args: {
        workspacePath: handle.path,
        repoFullName: "o/r",
        branch: "feat/x",
        baseBranch: undefined,
        message: "x",
        remoteBranch: "cognia/issue-5",
        token: undefined,
      },
    })
  })

  it("propagates the Rust 'no changes' error verbatim", async () => {
    call.mockRejectedValueOnce("commitAndPush: no changes to commit")
    await expect(commitAndPush({ workspace: handle, message: "x" })).rejects.toMatch(/no changes/)
  })

  it("rejects e2b workspace when no backend is registered", async () => {
    await expect(
      commitAndPush({ workspace: { ...handle, backend: "e2b" }, message: "x" })
    ).rejects.toThrow(/e2b workspace backend not registered/)
    expect(call).not.toHaveBeenCalled()
  })

  it("delegates commitAndPush to the registered E2B backend", async () => {
    const backend: E2BBackend = {
      clone: jest.fn(),
      commitAndPush: jest.fn(async () => "deadbeef"),
      remove: jest.fn(async () => true),
    }
    registerPluginE2B(backend)
    const sha = await commitAndPush({
      workspace: { ...handle, backend: "e2b", path: "sb-id" },
      message: "msg",
      remoteBranch: "feat/x",
    })
    expect(sha).toBe("deadbeef")
    expect(backend.commitAndPush).toHaveBeenCalledWith({
      workspace: expect.objectContaining({ path: "sb-id" }),
      message: "msg",
      remoteBranch: "feat/x",
    })
    expect(call).not.toHaveBeenCalled()
  })
})

describe("removeWorkspace + statWorkspace", () => {
  const localHandle: WorkspaceHandle = {
    backend: "local",
    path: "/tmp/ws/o_r/abc",
    repoFullName: "o/r",
    branch: "main",
    createdAt: 0,
  }

  it("returns the Rust bool for a successful local rm", async () => {
    call.mockResolvedValueOnce(true)
    const ok = await removeWorkspace(localHandle)
    expect(ok).toBe(true)
    expect(call).toHaveBeenCalledWith("github_workspace_remove", { path: localHandle.path })
  })

  it("logs and returns false when the Rust command rejects", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    call.mockRejectedValueOnce("rm failed")
    const ok = await removeWorkspace(localHandle)
    expect(ok).toBe(false)
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it("returns false for e2b handle when no backend is registered", async () => {
    const ok = await removeWorkspace({
      backend: "e2b",
      path: "sandbox-123",
      repoFullName: "o/r",
      branch: "main",
      createdAt: 0,
    })
    expect(ok).toBe(false)
    expect(call).not.toHaveBeenCalled()
  })

  it("delegates removal to the registered E2B backend", async () => {
    const backend: E2BBackend = {
      clone: jest.fn(),
      commitAndPush: jest.fn(),
      remove: jest.fn(async () => true),
    }
    registerPluginE2B(backend)
    const ok = await removeWorkspace({
      backend: "e2b",
      path: "sb",
      repoFullName: "o/r",
      branch: "main",
      createdAt: 0,
    })
    expect(ok).toBe(true)
    expect(backend.remove).toHaveBeenCalled()
  })

  it("keeps existing E2B handles bound to their draining backend after unregister", async () => {
    const backend: E2BBackend = {
      clone: jest.fn(async () => ({
        backend: "e2b" as const,
        path: "sb-draining",
        repoFullName: "o/r",
        branch: "main",
        createdAt: 0,
      })),
      commitAndPush: jest.fn(async () => "sha"),
      remove: jest.fn(async () => true),
    }
    registerPluginE2B(backend)
    const handle = await cloneToWorkspace({
      repoFullName: "o/r",
      branch: "main",
      token: "tok",
      backend: "e2b",
    })
    unregisterWorkspaceBackend("cognia-e2b-sandbox:e2b")

    await expect(commitAndPush({ workspace: handle, message: "done" })).resolves.toBe("sha")
    await expect(removeWorkspace(handle)).resolves.toBe(true)
    expect(backend.remove).toHaveBeenCalledWith(handle)
    await expect(
      cloneToWorkspace({ repoFullName: "o/r", branch: "main", token: "tok", backend: "e2b" })
    ).rejects.toThrow(/not registered/)
  })

  it("retains failed E2B handle cleanup for retry after unregister", async () => {
    const backend: E2BBackend = {
      clone: jest.fn(async () => ({
        backend: "e2b" as const,
        path: "sb-retry",
        repoFullName: "o/r",
        branch: "main",
        createdAt: 0,
      })),
      commitAndPush: jest.fn(),
      remove: jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
    }
    registerPluginE2B(backend)
    const handle = await cloneToWorkspace({
      repoFullName: "o/r",
      branch: "main",
      token: "tok",
      backend: "e2b",
    })
    unregisterWorkspaceBackend("cognia-e2b-sandbox:e2b")

    await expect(removeWorkspace(handle)).resolves.toBe(false)
    await expect(removeWorkspace(handle)).resolves.toBe(true)
    expect(backend.remove).toHaveBeenCalledTimes(2)
  })

  it("logs and returns false when the E2B backend rejects", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    registerPluginE2B({
      clone: jest.fn(),
      commitAndPush: jest.fn(),
      remove: jest.fn(async () => Promise.reject(new Error("e2b boom"))),
    })
    const ok = await removeWorkspace({
      backend: "e2b",
      path: "sb",
      repoFullName: "o/r",
      branch: "main",
      createdAt: 0,
    })
    expect(ok).toBe(false)
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it("statWorkspace returns the Rust shape on success", async () => {
    call.mockResolvedValueOnce({ exists: true, mtime: 1234.5 })
    const s = await statWorkspace("/some/path")
    expect(s).toEqual({ exists: true, mtime: 1234.5 })
    expect(call).toHaveBeenCalledWith("github_workspace_stat", { path: "/some/path" })
  })

  it("statWorkspace swallows command rejections as { exists: false }", async () => {
    call.mockRejectedValueOnce("nope")
    const s = await statWorkspace("/some/path")
    expect(s).toEqual({ exists: false })
  })
})

describe("e2b backend resolution by kind", () => {
  it("throws a helpful error when no e2b backend is registered", async () => {
    await expect(
      cloneToWorkspace({ repoFullName: "o/r", branch: "main", token: "tok", backend: "e2b" })
    ).rejects.toThrow(/e2b workspace backend not registered/)
    await expect(
      commitAndPush({
        workspace: {
          backend: "e2b",
          path: "sb",
          repoFullName: "o/r",
          branch: "main",
          createdAt: 0,
        },
        message: "m",
      })
    ).rejects.toThrow(/e2b workspace backend not registered/)
    await expect(
      removeWorkspace({
        backend: "e2b",
        path: "sb",
        repoFullName: "o/r",
        branch: "main",
        createdAt: 0,
      })
    ).resolves.toBe(false)
  })

  it("resolves a plugin-prefixed registration (`<pluginId>:e2b`) for the bare `e2b` kind", async () => {
    const backend: E2BBackend = {
      clone: jest.fn(async () => ({
        backend: "e2b" as const,
        path: "sb-prefixed",
        repoFullName: "o/r",
        branch: "main",
        createdAt: 0,
      })),
      commitAndPush: jest.fn(),
      remove: jest.fn(async () => true),
    }
    registerPluginE2B(backend, "some-other-plugin")
    const handle = await cloneToWorkspace({
      repoFullName: "o/r",
      branch: "main",
      token: "tok",
      backend: "e2b",
    })
    expect(handle.path).toBe("sb-prefixed")
  })

  it("prefers an exact unprefixed `e2b` registration over a plugin-prefixed one", async () => {
    const exact: E2BBackend = {
      clone: jest.fn(async () => ({
        backend: "e2b" as const,
        path: "exact",
        repoFullName: "o/r",
        branch: "main",
        createdAt: 0,
      })),
      commitAndPush: jest.fn(),
      remove: jest.fn(async () => true),
    }
    const prefixed: E2BBackend = {
      clone: jest.fn(async () => ({
        backend: "e2b" as const,
        path: "prefixed",
        repoFullName: "o/r",
        branch: "main",
        createdAt: 0,
      })),
      commitAndPush: jest.fn(),
      remove: jest.fn(async () => true),
    }
    registerPluginE2B(prefixed)
    registerWorkspaceBackend({
      backendId: "e2b",
      pluginId: "host",
      label: "host e2b",
      backend: exact,
    })
    const handle = await cloneToWorkspace({
      repoFullName: "o/r",
      branch: "main",
      token: "tok",
      backend: "e2b",
    })
    expect(handle.path).toBe("exact")
    expect(prefixed.clone).not.toHaveBeenCalled()
  })
})
