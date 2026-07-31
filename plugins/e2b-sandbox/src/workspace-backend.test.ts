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
    })
  })

  it("resolves E2B_DOMAIN and AgentENV's E2B_API_URL environment aliases", () => {
    const prevKey = process.env.E2B_API_KEY
    const prevDomain = process.env.E2B_DOMAIN
    const prevApiUrl = process.env.E2B_API_URL
    try {
      process.env.E2B_API_KEY = "env-key"
      delete process.env.E2B_DOMAIN
      process.env.E2B_API_URL = "http://agentenv.local:8000"
      expect(resolveSandboxConnection({})).toEqual({
        apiKey: "env-key",
        domain: "http://agentenv.local:8000",
      })

      process.env.E2B_DOMAIN = "https://e2b.example"
      expect(resolveSandboxConnection({})).toEqual({
        apiKey: "env-key",
        domain: "https://e2b.example",
      })
    } finally {
      if (prevKey === undefined) delete process.env.E2B_API_KEY
      else process.env.E2B_API_KEY = prevKey
      if (prevDomain === undefined) delete process.env.E2B_DOMAIN
      else process.env.E2B_DOMAIN = prevDomain
      if (prevApiUrl === undefined) delete process.env.E2B_API_URL
      else process.env.E2B_API_URL = prevApiUrl
    }
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
