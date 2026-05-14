import { createE2BBackend, setE2BSandboxFactory, type E2BSandboxLike } from "./workspace-e2b"

function makeFakeSandbox(overrides: Partial<E2BSandboxLike> = {}): E2BSandboxLike {
  const calls: Array<{ method: string; args: unknown[] }> = []
  function record<T>(method: string) {
    return async (...args: unknown[]): Promise<T> => {
      calls.push({ method, args })
      return undefined as unknown as T
    }
  }
  const sb: E2BSandboxLike & { calls: typeof calls } = {
    sandboxId: "sbx_test_1",
    git: {
      clone: record("git.clone"),
      add: record("git.add"),
      commit: record("git.commit"),
      push: record("git.push"),
      setConfig: record("git.setConfig"),
    },
    commands: {
      run: jest.fn(async () => ({ stdout: "deadbeef\n", stderr: "", exitCode: 0 })),
    },
    kill: jest.fn(async () => true),
    calls,
    ...overrides,
  } as E2BSandboxLike & { calls: typeof calls }
  return sb
}

afterEach(() => {
  setE2BSandboxFactory(null)
})

describe("createE2BBackend.clone", () => {
  it("provisions a sandbox, clones, and returns an e2b WorkspaceHandle", async () => {
    const sandbox = makeFakeSandbox()
    const factoryCreate = jest.fn(async () => sandbox)
    const factory = { create: factoryCreate, connect: jest.fn() }
    const backend = createE2BBackend({
      getApiKey: async () => "e2b_test_key",
      factoryOverride: factory,
    })
    const handle = await backend.clone({
      repoFullName: "octocat/hello-world",
      branch: "feat/x",
      token: "ghs_xxx",
    })
    expect(handle).toMatchObject({
      backend: "e2b",
      path: "sbx_test_1",
      repoFullName: "octocat/hello-world",
      branch: "feat/x",
    })
    expect(factoryCreate).toHaveBeenCalledWith({
      apiKey: "e2b_test_key",
      timeoutMs: expect.any(Number),
    })
    const calls = (sandbox as unknown as { calls: Array<{ method: string }> }).calls
    expect(calls.map((c) => c.method)).toEqual(["git.clone", "git.setConfig", "git.setConfig"])
  })

  it("rejects when no API key is configured", async () => {
    const backend = createE2BBackend({
      getApiKey: async () => null,
      factoryOverride: { create: jest.fn(), connect: jest.fn() },
    })
    await expect(
      backend.clone({ repoFullName: "x/y", branch: "main", token: "t" })
    ).rejects.toThrow(/API key/)
  })

  it("kills the sandbox if the clone throws", async () => {
    const sandbox = makeFakeSandbox()
    sandbox.git.clone = async () => {
      throw new Error("bad credentials")
    }
    const factory = { create: jest.fn(async () => sandbox), connect: jest.fn() }
    const backend = createE2BBackend({
      getApiKey: async () => "k",
      factoryOverride: factory,
    })
    await expect(
      backend.clone({ repoFullName: "x/y", branch: "main", token: "t" })
    ).rejects.toThrow(/bad credentials/)
    expect((sandbox.kill as jest.Mock).mock.calls).toHaveLength(1)
  })
})

describe("createE2BBackend.commitAndPush", () => {
  it("reconnects to the sandbox and pushes, returning the commit SHA", async () => {
    const sandbox = makeFakeSandbox()
    const factory = {
      create: jest.fn(),
      connect: jest.fn(async () => sandbox),
    }
    const backend = createE2BBackend({
      getApiKey: async () => "k",
      factoryOverride: factory,
    })
    const sha = await backend.commitAndPush({
      workspace: {
        backend: "e2b",
        path: "sbx_abc",
        repoFullName: "x/y",
        branch: "main",
        createdAt: 0,
      },
      message: "chore: bot commit",
      remoteBranch: "cognia/feat-1",
    })
    expect(sha).toBe("deadbeef")
    expect(factory.connect).toHaveBeenCalledWith("sbx_abc", { apiKey: "k" })
    const calls = (sandbox as unknown as { calls: Array<{ method: string }> }).calls
    expect(calls.map((c) => c.method)).toEqual(["git.add", "git.commit", "git.push"])
  })
})

describe("createE2BBackend.remove", () => {
  it("returns the kill() outcome", async () => {
    const sandbox = makeFakeSandbox()
    const factory = {
      create: jest.fn(),
      connect: jest.fn(async () => sandbox),
    }
    const backend = createE2BBackend({
      getApiKey: async () => "k",
      factoryOverride: factory,
    })
    const ok = await backend.remove({
      backend: "e2b",
      path: "sbx_kill",
      repoFullName: "x/y",
      branch: "m",
      createdAt: 0,
    })
    expect(ok).toBe(true)
    expect((sandbox.kill as jest.Mock).mock.calls).toHaveLength(1)
  })

  it("returns false rather than throwing when remove fails", async () => {
    const sandbox = makeFakeSandbox()
    sandbox.kill = jest.fn(async () => {
      throw new Error("gone")
    }) as never
    const factory = {
      create: jest.fn(),
      connect: jest.fn(async () => sandbox),
    }
    const backend = createE2BBackend({
      getApiKey: async () => "k",
      factoryOverride: factory,
    })
    await expect(
      backend.remove({
        backend: "e2b",
        path: "sbx_x",
        repoFullName: "x/y",
        branch: "m",
        createdAt: 0,
      })
    ).resolves.toBe(false)
  })
})
