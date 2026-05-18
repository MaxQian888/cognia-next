jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { invoke } = require("@tauri-apps/api/core") as { invoke: jest.Mock }

import {
  cloneToWorkspace,
  commitAndPush,
  getE2BBackend,
  removeWorkspace,
  setE2BBackend,
  statWorkspace,
  type E2BBackend,
  type WorkspaceHandle,
} from "./workspace"

beforeEach(() => {
  invoke.mockReset()
  setE2BBackend(null)
})

describe("cloneToWorkspace — local backend", () => {
  it("invokes github_workspace_clone and synthesizes a WorkspaceHandle", async () => {
    invoke.mockResolvedValueOnce({ path: "/tmp/ws/octocat_hello-world/abc", createdAt: 123 })
    const handle = await cloneToWorkspace({
      repoFullName: "octocat/hello-world",
      branch: "main",
      token: "x",
      backend: "local",
      baseDir: "/tmp/ws",
    })
    expect(invoke).toHaveBeenCalledWith("github_workspace_clone", {
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
      createdAt: 123,
    })
  })

  it("forwards baseDir undefined when not supplied", async () => {
    invoke.mockResolvedValueOnce({ path: "/some/path", createdAt: 0 })
    await cloneToWorkspace({
      repoFullName: "o/r",
      branch: "main",
      token: "tok",
      backend: "local",
    })
    expect(invoke).toHaveBeenCalledWith("github_workspace_clone", {
      args: { repoFullName: "o/r", branch: "main", token: "tok", baseDir: undefined },
    })
  })

  it("propagates a Rust-side clone failure", async () => {
    invoke.mockRejectedValueOnce("git clone failed: branch not found")
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
    expect(invoke).not.toHaveBeenCalled()
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
    setE2BBackend(backend)
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
    expect(invoke).not.toHaveBeenCalled()
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
    invoke.mockResolvedValueOnce("deadbeef\n")
    const sha = await commitAndPush({ workspace: handle, message: "Cognia: do the thing" })
    expect(sha).toBe("deadbeef\n")
    expect(invoke).toHaveBeenCalledWith("github_workspace_commit_and_push", {
      args: {
        workspacePath: handle.path,
        branch: "feat/x",
        message: "Cognia: do the thing",
        remoteBranch: undefined,
      },
    })
  })

  it("forwards remoteBranch when supplied", async () => {
    invoke.mockResolvedValueOnce("sha")
    await commitAndPush({
      workspace: handle,
      message: "x",
      remoteBranch: "cognia/issue-5",
    })
    expect(invoke).toHaveBeenCalledWith("github_workspace_commit_and_push", {
      args: {
        workspacePath: handle.path,
        branch: "feat/x",
        message: "x",
        remoteBranch: "cognia/issue-5",
      },
    })
  })

  it("propagates the Rust 'no changes' error verbatim", async () => {
    invoke.mockRejectedValueOnce("commitAndPush: no changes to commit")
    await expect(commitAndPush({ workspace: handle, message: "x" })).rejects.toMatch(/no changes/)
  })

  it("rejects e2b workspace when no backend is registered", async () => {
    await expect(
      commitAndPush({ workspace: { ...handle, backend: "e2b" }, message: "x" })
    ).rejects.toThrow(/e2b workspace backend not registered/)
    expect(invoke).not.toHaveBeenCalled()
  })

  it("delegates commitAndPush to the registered E2B backend", async () => {
    const backend: E2BBackend = {
      clone: jest.fn(),
      commitAndPush: jest.fn(async () => "deadbeef"),
      remove: jest.fn(async () => true),
    }
    setE2BBackend(backend)
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
    expect(invoke).not.toHaveBeenCalled()
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
    invoke.mockResolvedValueOnce(true)
    const ok = await removeWorkspace(localHandle)
    expect(ok).toBe(true)
    expect(invoke).toHaveBeenCalledWith("github_workspace_remove", { path: localHandle.path })
  })

  it("logs and returns false when the Rust command rejects", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    invoke.mockRejectedValueOnce("rm failed")
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
    expect(invoke).not.toHaveBeenCalled()
  })

  it("delegates removal to the registered E2B backend", async () => {
    const backend: E2BBackend = {
      clone: jest.fn(),
      commitAndPush: jest.fn(),
      remove: jest.fn(async () => true),
    }
    setE2BBackend(backend)
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

  it("logs and returns false when the E2B backend rejects", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    setE2BBackend({
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
    invoke.mockResolvedValueOnce({ exists: true, mtime: 1234.5 })
    const s = await statWorkspace("/some/path")
    expect(s).toEqual({ exists: true, mtime: 1234.5 })
    expect(invoke).toHaveBeenCalledWith("github_workspace_stat", { path: "/some/path" })
  })

  it("statWorkspace swallows command rejections as { exists: false }", async () => {
    invoke.mockRejectedValueOnce("nope")
    const s = await statWorkspace("/some/path")
    expect(s).toEqual({ exists: false })
  })
})

describe("setE2BBackend / getE2BBackend", () => {
  it("round-trips the singleton", () => {
    expect(getE2BBackend()).toBeNull()
    const b: E2BBackend = {
      clone: jest.fn(),
      commitAndPush: jest.fn(),
      remove: jest.fn(),
    }
    setE2BBackend(b)
    expect(getE2BBackend()).toBe(b)
    setE2BBackend(null)
    expect(getE2BBackend()).toBeNull()
  })
})
