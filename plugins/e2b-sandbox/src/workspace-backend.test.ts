import {
  adaptSdkSandbox,
  E2BWorkspaceBackend,
  gitCredentialEnv,
  resolveSandboxConnection,
} from "./workspace-backend"

/** The env-support probe the backend runs before it will send a credential. */
const PROBE = /^printf %s "\$([A-Z0-9_]+)"$/

/**
 * Answer the probe the way a facade that honours `envs` would: echo back
 * exactly what the caller put in the environment. A mock that ignored `envs`
 * would return an empty string here, which is the failure the probe exists to
 * catch, so this helper is also the definition of "supports envs".
 */
function probeAnswer(cmd: string, envs?: Record<string, string>) {
  const match = PROBE.exec(cmd)
  if (!match) return undefined
  return { stdout: envs?.[match[1]] ?? "", stderr: "", exitCode: 0 }
}

function makeSandbox(id: string) {
  const exec = jest.fn(
    async ({ cmd, envs }: { cmd: string; cwd?: string; envs?: Record<string, string> }) => {
      const probe = probeAnswer(cmd, envs)
      if (probe) return probe
      if (cmd.startsWith("git log")) {
        return { stdout: "abc123def\n", stderr: "", exitCode: 0 }
      }
      return { stdout: "", stderr: "", exitCode: 0 }
    }
  )
  const close = jest.fn(async () => undefined)
  return { id, exec, close }
}

/** A facade from an older SDK: it accepts the field and silently drops it. */
function makeSandboxThatIgnoresEnv(id: string) {
  const exec = jest.fn(
    async ({ cmd }: { cmd: string; cwd?: string; envs?: Record<string, string> }) => {
      if (cmd.startsWith("git log")) {
        return { stdout: "abc123def\n", stderr: "", exitCode: 0 }
      }
      return { stdout: "", stderr: "", exitCode: 0 }
    }
  )
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
    // ADR-0176: the credential travels in the environment. A token on argv is
    // readable by anything inside the microVM that can list processes, and git
    // echoes the remote URL back verbatim in its own failures.
    expect(calls.some((c) => c.includes("ghs_test"))).toBe(false)
    const clone = calls.find((c) => c.includes("git clone"))!
    expect(clone).toContain("https://github.com/octo/hello-world.git")
    // Never shallow: a truncated history cannot be rebased past its boundary,
    // which is what a stacked branch has to do when the branch below it moves.
    expect(clone).not.toContain("--depth")
    expect(clone).toContain("--filter=blob:none")
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
    sandbox.exec.mockImplementation(async ({ cmd, envs }) => {
      const probe = probeAnswer(cmd, envs)
      if (probe) return probe
      return { stdout: "", stderr: "permission denied", exitCode: 1 }
    })
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
    sandbox.exec.mockImplementation(async ({ cmd, envs }) => {
      const probe = probeAnswer(cmd, envs)
      if (probe) return probe
      return { stdout: "", stderr: "clone failed", exitCode: 1 }
    })
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
      token: "ghs_push",
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
      token: "ghs_push",
    })
    const pushCall = sandbox.exec.mock.calls.find((c) =>
      String(c[0].cmd).includes("git push origin")
    )
    expect(String(pushCall?.[0].cmd)).toContain("cognia/issue-7")
  })

  it("never lets the token reach a sandbox command line", async () => {
    const sandbox = makeSandbox("sb-secret")
    const backend = new E2BWorkspaceBackend({ sandboxFactory: async () => sandbox })
    const handle = await backend.clone({
      repoFullName: "octo/hello-world",
      branch: "main",
      token: "ghs_SECRET",
    })
    await backend.commitAndPush({ workspace: handle, message: "m", token: "ghs_SECRET" })

    const calls = sandbox.exec.mock.calls.map((c) => c[0])
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(String(call.cmd)).not.toContain("ghs_SECRET")
      expect(String(call.cwd ?? "")).not.toContain("ghs_SECRET")
    }
    // It reached the sandbox, just out of band: base64, keyed on the origin.
    const authed = calls.filter((c) => c.envs?.GIT_CONFIG_VALUE_0)
    expect(authed.length).toBe(2)
    for (const call of authed) {
      expect(call.envs?.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader")
      expect(call.envs?.GIT_CONFIG_VALUE_0).toBe(
        `Authorization: Basic ${btoa("x-access-token:ghs_SECRET")}`
      )
    }
  })

  it("refuses to clone through a facade that drops the environment", async () => {
    const sandbox = makeSandboxThatIgnoresEnv("sb-no-env")
    const backend = new E2BWorkspaceBackend({ sandboxFactory: async () => sandbox })

    await expect(
      backend.clone({ repoFullName: "o/r", branch: "main", token: "ghs_SECRET" })
    ).rejects.toThrow(/does not forward per-command environment variables/)

    // Refused, not degraded: nothing was cloned and the token never appeared.
    const calls = sandbox.exec.mock.calls.map((c) => String(c[0].cmd))
    expect(calls.some((c) => c.includes("git clone"))).toBe(false)
    expect(calls.some((c) => c.includes("ghs_SECRET"))).toBe(false)
    expect(sandbox.close).toHaveBeenCalled()
  })

  it("refuses to push without a token rather than failing inside git", async () => {
    const sandbox = makeSandbox("sb-no-token")
    const backend = new E2BWorkspaceBackend({ sandboxFactory: async () => sandbox })
    const handle = await backend.clone({ repoFullName: "o/r", branch: "main", token: "t" })

    await expect(backend.commitAndPush({ workspace: handle, message: "m" })).rejects.toThrow(
      /requires a GitHub token/
    )
    const calls = sandbox.exec.mock.calls.map((c) => String(c[0].cmd))
    expect(calls.some((c) => c.includes("git push"))).toBe(false)
  })

  it("probes each sandbox once, not once per command", async () => {
    const sandbox = makeSandbox("sb-probe-once")
    const backend = new E2BWorkspaceBackend({ sandboxFactory: async () => sandbox })
    const handle = await backend.clone({ repoFullName: "o/r", branch: "main", token: "t" })
    await backend.commitAndPush({ workspace: handle, message: "m", token: "t" })

    const probes = sandbox.exec.mock.calls.filter((c) => PROBE.test(String(c[0].cmd)))
    expect(probes).toHaveLength(1)
  })

  it("keys the credential on the remote and refuses a non-https one", () => {
    expect(gitCredentialEnv("https://ghe.example.com/o/r.git", "t").GIT_CONFIG_KEY_0).toBe(
      "http.https://ghe.example.com/.extraheader"
    )
    expect(() => gitCredentialEnv("git@github.com:o/r.git", "t")).toThrow(/no https origin/)
    expect(() => gitCredentialEnv("http://insecure.example/o/r.git", "t")).toThrow(
      /no https origin/
    )
  })

  it("adapts the real SDK's commands.run, including its envs and non-zero exits", async () => {
    const run = jest.fn(async (cmd: string, opts?: { envs?: Record<string, string> }) => {
      if (cmd === "boom") {
        throw Object.assign(new Error("nope"), { exitCode: 2, stderr: "nope" })
      }
      return { stdout: opts?.envs?.WANTED ?? "", stderr: "", exitCode: 0 }
    })
    const kill = jest.fn(async () => undefined)
    const facade = adaptSdkSandbox({ sandboxId: "sb-sdk", commands: { run }, kill })

    expect(facade.id).toBe("sb-sdk")
    await expect(facade.exec({ cmd: "echo", envs: { WANTED: "here" } })).resolves.toEqual({
      stdout: "here",
      stderr: "",
      exitCode: 0,
    })
    // A rejection that carries an exit code is a failed command, not a broken
    // sandbox: `execChecked` is the single place that decides what a non-zero
    // exit means.
    await expect(facade.exec({ cmd: "boom" })).resolves.toMatchObject({ exitCode: 2 })
    await facade.close()
    expect(kill).toHaveBeenCalled()
  })

  it("rejects an SDK object with no commands.run instead of returning a broken facade", () => {
    expect(() => adaptSdkSandbox({ commands: {} } as never)).toThrow(/commands\.run/)
  })

  it("falls back to `id` when the SDK exposes no `sandboxId`, and to close() when no kill()", async () => {
    const run = jest.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }))
    const close = jest.fn(async () => undefined)
    const facade = adaptSdkSandbox({ id: "legacy-id", commands: { run }, close })
    expect(facade.id).toBe("legacy-id")
    await facade.close()
    expect(close).toHaveBeenCalledTimes(1)

    const nothing = adaptSdkSandbox({ commands: { run } })
    await expect(nothing.close()).rejects.toThrow(/neither `kill` nor `close`/)
  })

  it("clone without an injected factory surfaces the dormant-build error — not an install hint", async () => {
    // `e2b` is not a dependency of this bundle, and a bare-specifier import()
    // cannot resolve inside the shipped webview anyway — the failure is the
    // contract. The message must name the state honestly (ADR rules: dormancy
    // is documented, labeled, and pinned by a test).
    const backend = new E2BWorkspaceBackend({ now: () => 0 })
    await expect(
      backend.clone({ repoFullName: "o/r", branch: "main", token: "t" })
    ).rejects.toThrow(/unavailable in this build/)
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

  it("retains a failed remove for a later cleanup retry", async () => {
    const sandbox = makeSandbox("sb-remove-retry")
    sandbox.close.mockRejectedValueOnce(new Error("close failed"))
    const backend = new E2BWorkspaceBackend({ sandboxFactory: async () => sandbox })
    const handle = await backend.clone({ repoFullName: "o/r", branch: "main", token: "t" })

    await expect(backend.remove(handle)).resolves.toBe(false)
    expect(backend.liveSandboxCount()).toBe(1)
    await expect(backend.remove(handle)).resolves.toBe(true)
    expect(sandbox.close).toHaveBeenCalledTimes(2)
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
        token: "ghs_push",
      })
    ).rejects.toThrow(/no live sandbox/)
  })

  it("escapes single quotes inside the commit message", async () => {
    const sandbox = makeSandbox("sb-5")
    const backend = new E2BWorkspaceBackend({ sandboxFactory: async () => sandbox })
    const handle = await backend.clone({ repoFullName: "o/r", branch: "main", token: "t" })
    await backend.commitAndPush({ workspace: handle, message: "it's fine", token: "t" })
    const commitCall = sandbox.exec.mock.calls.find((c) =>
      String(c[0].cmd).includes("git commit -m")
    )
    expect(String(commitCall?.[0].cmd)).toContain("it'\"'\"'s fine")
  })
})
