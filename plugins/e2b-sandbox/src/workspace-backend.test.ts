import { E2BWorkspaceBackend, resolveSandboxConnection } from "./workspace-backend"

function makeSandbox(id: string) {
  const exec = jest.fn(async ({ cmd }: { cmd: string }) => {
    if (cmd.startsWith("git log")) {
      return { stdout: "abc123def\n", stderr: "", exitCode: 0 }
    }
    return { stdout: "", stderr: "", exitCode: 0 }
  })
  const close = jest.fn(async () => undefined)
  return { id, exec, close }
}

describe("E2BWorkspaceBackend", () => {
  it("clones into /tmp/cognia/<repo>/<stamp> and returns an e2b WorkspaceHandle", async () => {
    const sandbox = makeSandbox("sb-1")
    const sandboxFactory = jest.fn(async () => sandbox)
    const backend = new E2BWorkspaceBackend({ sandboxFactory, now: () => 1000 })
    const handle = await backend.clone({
      repoFullName: "octo/hello-world",
      branch: "main",
      token: "ghs_test",
    })
    expect(handle.backend).toBe("e2b")
    expect(handle.path).toMatch(/^\/tmp\/cognia\/octo_hello-world\//)
    expect(handle.repoFullName).toBe("octo/hello-world")
    expect(handle.branch).toBe("main")
    expect(backend.liveSandboxCount()).toBe(1)
    // sandbox saw mkdir + git clone calls.
    const calls = sandbox.exec.mock.calls.map((c) => c[0].cmd as string)
    expect(calls.some((c) => c.startsWith("mkdir -p"))).toBe(true)
    expect(calls.some((c) => c.includes("git clone"))).toBe(true)
    expect(calls.some((c) => c.includes("ghs_test"))).toBe(true)
  })

  it("passes AgentENV apiUrl to the SDK factory as domain", async () => {
    const sandbox = makeSandbox("sb-agentenv")
    const sandboxFactory = jest.fn(async () => sandbox)
    const backend = new E2BWorkspaceBackend({
      apiKey: "key-1",
      apiUrl: "http://127.0.0.1:8000",
      sandboxFactory,
    })
    await backend.clone({
      repoFullName: "octo/hello-world",
      branch: "main",
      token: "ghs_test",
    })
    expect(sandboxFactory).toHaveBeenCalledWith({
      apiKey: "key-1",
      domain: "http://127.0.0.1:8000",
      allowInternetAccess: true,
    })
  })

  it("prefers trimmed live plugin configuration over construction defaults", () => {
    expect(
      resolveSandboxConnection({
        apiKey: "fallback-key",
        apiUrl: "https://fallback.example",
        connection: () => ({
          apiKey: " live-key ",
          domain: " http://agentenv.local:8000 ",
        }),
      })
    ).toEqual({
      apiKey: "live-key",
      domain: "http://agentenv.local:8000",
    })
  })

  it("falls back to explicit options and omits blank values", () => {
    expect(
      resolveSandboxConnection({
        apiKey: " ",
        domain: "",
        apiUrl: " http://127.0.0.1:8000 ",
      })
    ).toEqual({
      domain: "http://127.0.0.1:8000",
    })
  })

  it("cleans up the sandbox when clone exec fails", async () => {
    const sandbox = makeSandbox("sb-2")
    sandbox.exec.mockImplementation(async () => ({
      stdout: "",
      stderr: "permission denied",
      exitCode: 1,
    }))
    const sandboxFactory = jest.fn(async () => sandbox)
    const backend = new E2BWorkspaceBackend({ sandboxFactory })
    await expect(
      backend.clone({ repoFullName: "o/r", branch: "main", token: "t" })
    ).rejects.toThrow(/permission denied/)
    expect(sandbox.close).toHaveBeenCalled()
    expect(backend.liveSandboxCount()).toBe(0)
  })

  it("surfaces cleanup failure when a failed clone cannot close the sandbox", async () => {
    const sandbox = makeSandbox("sb-leaked")
    sandbox.exec.mockResolvedValueOnce({ stdout: "", stderr: "clone failed", exitCode: 1 })
    sandbox.close.mockRejectedValueOnce(new Error("close failed"))
    const backend = new E2BWorkspaceBackend({ sandboxFactory: async () => sandbox })

    await expect(
      backend.clone({ repoFullName: "o/r", branch: "main", token: "t" })
    ).rejects.toThrow(/could not be closed/)
  })

  it("commitAndPush runs git add+commit+push inside the sandbox and returns the SHA", async () => {
    const sandbox = makeSandbox("sb-3")
    const backend = new E2BWorkspaceBackend({ sandboxFactory: async () => sandbox })
    const handle = await backend.clone({
      repoFullName: "o/r",
      branch: "feature/x",
      token: "t",
    })
    const sha = await backend.commitAndPush({
      workspace: handle,
      message: "feat: add thing",
    })
    expect(sha).toBe("abc123def")
    const pushCall = sandbox.exec.mock.calls.find((c) =>
      String(c[0].cmd).includes("git push origin")
    )
    expect(pushCall).toBeDefined()
    expect(String(pushCall?.[0].cmd)).toContain("feature/x")
  })

  it("commitAndPush honours an explicit remoteBranch", async () => {
    const sandbox = makeSandbox("sb-3b")
    const backend = new E2BWorkspaceBackend({ sandboxFactory: async () => sandbox })
    const handle = await backend.clone({ repoFullName: "o/r", branch: "main", token: "t" })
    await backend.commitAndPush({
      workspace: handle,
      message: "m",
      remoteBranch: "cognia/issue-7",
    })
    const pushCall = sandbox.exec.mock.calls.find((c) =>
      String(c[0].cmd).includes("git push origin")
    )
    expect(String(pushCall?.[0].cmd)).toContain("cognia/issue-7")
  })

  it("remove closes the sandbox and forgets it", async () => {
    const sandbox = makeSandbox("sb-4")
    const backend = new E2BWorkspaceBackend({ sandboxFactory: async () => sandbox })
    const handle = await backend.clone({ repoFullName: "o/r", branch: "main", token: "t" })
    expect(backend.liveSandboxCount()).toBe(1)
    const ok = await backend.remove(handle)
    expect(ok).toBe(true)
    expect(sandbox.close).toHaveBeenCalled()
    expect(backend.liveSandboxCount()).toBe(0)
  })

  it("remove returns false when no sandbox is tracked", async () => {
    const backend = new E2BWorkspaceBackend({ sandboxFactory: async () => makeSandbox("sb-x") })
    const handle = {
      backend: "e2b" as const,
      path: "/tmp/cognia/unknown/0",
      repoFullName: "o/r",
      branch: "main",
      createdAt: 0,
    }
    const ok = await backend.remove(handle)
    expect(ok).toBe(false)
  })

  it("commitAndPush throws a clear error when no sandbox is live", async () => {
    const backend = new E2BWorkspaceBackend({ sandboxFactory: async () => makeSandbox("x") })
    await expect(
      backend.commitAndPush({
        workspace: {
          backend: "e2b",
          path: "/tmp/cognia/none/0",
          repoFullName: "o/r",
          branch: "main",
          createdAt: 0,
        },
        message: "m",
      })
    ).rejects.toThrow(/no live sandbox/)
  })

  it("escapes single quotes inside the commit message", async () => {
    const sandbox = makeSandbox("sb-5")
    const backend = new E2BWorkspaceBackend({ sandboxFactory: async () => sandbox })
    const handle = await backend.clone({ repoFullName: "o/r", branch: "main", token: "t" })
    await backend.commitAndPush({ workspace: handle, message: "it's fine" })
    const commitCall = sandbox.exec.mock.calls.find((c) =>
      String(c[0].cmd).includes("git commit -m")
    )
    expect(String(commitCall?.[0].cmd)).toContain("it'\"'\"'s fine")
  })
})
