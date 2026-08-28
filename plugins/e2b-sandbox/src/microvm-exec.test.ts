import type {
  MicrovmCeiling,
  MicrovmExecPayload,
  MicrovmRequest,
} from "@cognia/plugin-sdk/api/sandbox"
import { buildMicrovmExec } from "./microvm-exec"
import { E2BSandboxPool } from "./sandbox-pool"

function makeSandbox(id: string) {
  return {
    id,
    exec: jest.fn(async (_opts: { cmd: string; cwd?: string; timeoutMs?: number }) => ({
      stdout: "hello\n",
      stderr: "",
      exitCode: 0,
    })),
    close: jest.fn(async () => undefined),
  }
}

function payload(overrides: Partial<MicrovmExecPayload["request"]> = {}): MicrovmExecPayload {
  return {
    tool: "sandbox_bash",
    command: {
      argv: ["echo", "hello"],
      cwd: "/remote/work",
      env: { FOO: "bar" },
      stdin: null,
      timeout: 30,
    },
    request: {
      writable: ["/remote/work"],
      readable: [],
      targetFiles: [],
      maxCpuSeconds: 0,
      maxMemoryMb: 0,
      network: "on",
      networkHosts: [],
      ...overrides,
    },
  }
}

describe("buildMicrovmExec", () => {
  it("requires and claims an existing E2B workspace", async () => {
    const pool = new E2BSandboxPool()
    const adapter = buildMicrovmExec({ pool })
    await expect(adapter.preflight?.("runtime:a")).rejects.toThrow(/existing remote workspace/)
    await expect(adapter.preflight?.("runtime:a", "/missing")).rejects.toThrow(
      /no live E2B workspace/
    )
    await expect(adapter.preflight?.("runtime:b", "/missing")).rejects.toMatchObject({
      code: "workspace-unavailable",
    })
  })

  it("shares immutable generations only inside one owning session", async () => {
    const pool = new E2BSandboxPool()
    pool.addWorkspace("/remote/work", makeSandbox("vm"), "on")
    const adapter = buildMicrovmExec({ pool })

    await expect(
      adapter.preflight?.("runtime:a1", "/remote/work", "session:a")
    ).resolves.toBeUndefined()
    await expect(
      adapter.preflight?.("runtime:a2", "/remote/work", "session:a")
    ).resolves.toBeUndefined()
    await expect(
      adapter.preflight?.("runtime:b", "/remote/work", "session:b")
    ).rejects.toMatchObject({ code: "workspace-unavailable" })
  })

  it("reuses one sandbox for consecutive commands on the same runtime ref", async () => {
    const pool = new E2BSandboxPool()
    const vm = makeSandbox("vm-a")
    pool.addWorkspace("/remote/work", vm, "on")
    const adapter = buildMicrovmExec({ pool, now: () => 1000 })
    await adapter.preflight?.("runtime:a", "/remote/work")

    await expect(adapter.execute("runtime:a", payload())).resolves.toMatchObject({
      exit_code: 0,
      stdout: "hello\n",
    })
    await adapter.execute("runtime:a", payload())

    expect(vm.exec).toHaveBeenCalledTimes(2)
    expect(vm.close).not.toHaveBeenCalled()
    expect(vm.exec.mock.calls[0][0].cmd).toContain("export FOO='bar'")
    expect(vm.exec.mock.calls[0][0].cmd).toContain("'echo' 'hello'")
  })

  it("skips env names bash cannot accept instead of emitting a broken export", async () => {
    const pool = new E2BSandboxPool()
    const vm = makeSandbox("vm-a")
    pool.addWorkspace("/remote/work", vm, "on")
    const adapter = buildMicrovmExec({ pool })
    await adapter.preflight?.("runtime:a", "/remote/work")

    const call = payload()
    call.command.env = {
      OK_NAME: "keep",
      // Survives a character strip unchanged and is still not an identifier —
      // `export 1PASSWORD_TOKEN=…` is a syntax error that aborts the WHOLE
      // line, taking the model's actual command down with it.
      "1PASSWORD_TOKEN": "abc",
      // Strips to the empty string, which would emit `export =…`.
      "@": "at",
      "FOO-BAR": "dash",
    }
    await adapter.execute("runtime:a", call)

    const cmd = vm.exec.mock.calls[0][0].cmd
    expect(cmd).toContain("export OK_NAME='keep'")
    expect(cmd).not.toContain("1PASSWORD_TOKEN")
    expect(cmd).not.toContain("export =")
    // Not silently renamed into a different variable, either.
    expect(cmd).not.toContain("FOOBAR")
    // The real command still runs.
    expect(cmd).toContain("'echo' 'hello'")
  })

  it("isolates different runtime refs and releases each sandbox once", async () => {
    const pool = new E2BSandboxPool()
    const a = makeSandbox("vm-a")
    const b = makeSandbox("vm-b")
    pool.addWorkspace("/remote/a", a, "on")
    pool.addWorkspace("/remote/b", b, "on")
    const adapter = buildMicrovmExec({ pool })
    await adapter.preflight?.("runtime:a", "/remote/a")
    await adapter.preflight?.("runtime:b", "/remote/b")

    await adapter.execute("runtime:a", {
      ...payload(),
      command: { ...payload().command, cwd: "/remote/a" },
    })
    await adapter.execute("runtime:b", {
      ...payload(),
      command: { ...payload().command, cwd: "/remote/b" },
    })
    await Promise.all([adapter.release?.("runtime:a"), adapter.release?.("runtime:a")])

    expect(a.exec).toHaveBeenCalledTimes(1)
    expect(b.exec).toHaveBeenCalledTimes(1)
    expect(a.close).toHaveBeenCalledTimes(1)
    expect(b.close).not.toHaveBeenCalled()
  })

  it.each<[Partial<MicrovmRequest>, MicrovmCeiling | undefined, RegExp]>([
    [{ network: "allowlist", networkHosts: ["api.example.com"] }, undefined, /allowlists/],
    [{}, { network: "allowlist" }, /allowlists/],
    // A ceiling the instance cannot honour: the operator capped egress, the
    // workspace was created with it, and that cannot be undone after creation.
    [{ network: "off" }, { network: "off" }, /network=off ceiling cannot be applied/],
    [{ maxCpuSeconds: 10 }, { maxCpuSeconds: 10 }, /CPU and memory limits/],
    [{ maxMemoryMb: 512 }, { maxMemoryMb: 512 }, /CPU and memory limits/],
  ])("rejects a ceiling it cannot attest", async (request, ceiling, message) => {
    const pool = new E2BSandboxPool()
    pool.addWorkspace("/remote/work", makeSandbox("vm"), "on")
    const adapter = buildMicrovmExec({ pool })
    await adapter.preflight?.("runtime:a", "/remote/work")
    await expect(
      adapter.execute("runtime:a", {
        ...payload(request),
        ...(ceiling ? { ceiling } : {}),
      })
    ).rejects.toMatchObject({
      code: "policy-not-attested",
      message: expect.stringMatching(message),
    })
  })

  it("refuses egress the instance was not created with", async () => {
    const pool = new E2BSandboxPool()
    pool.addWorkspace("/remote/work", makeSandbox("vm"), "off")
    const adapter = buildMicrovmExec({ pool })
    await adapter.preflight?.("runtime:a", "/remote/work")
    await expect(adapter.execute("runtime:a", payload({ network: "on" }))).rejects.toMatchObject({
      code: "policy-not-attested",
      message: expect.stringMatching(/cannot be enabled after creation/),
    })
  })

  it.each<[Partial<MicrovmRequest>, MicrovmCeiling | undefined]>([
    // The file helpers always ask for `network: "off"` because they need no
    // egress — not because an operator capped it. Refusing that made every
    // sandbox_write / sandbox_edit / sandbox_text_editor call on this tier
    // impossible on a workspace that git-clone had to create with network on.
    [{ network: "off" }, undefined],
    [{ network: "off" }, { network: "on" }],
    // Caps that came from the clamp's "backend default", not from a ceiling.
    [{ maxCpuSeconds: 10, maxMemoryMb: 512 }, undefined],
  ])("runs a request that needs less than the instance provides", async (request, ceiling) => {
    const pool = new E2BSandboxPool()
    pool.addWorkspace("/remote/work", makeSandbox("vm"), "on")
    const adapter = buildMicrovmExec({ pool })
    await adapter.preflight?.("runtime:a", "/remote/work")
    await expect(
      adapter.execute("runtime:a", {
        ...payload(request),
        ...(ceiling ? { ceiling } : {}),
      })
    ).resolves.toMatchObject({ exit_code: 0 })
  })

  it("refuses cwd and target files outside the remote workspace", async () => {
    const pool = new E2BSandboxPool()
    pool.addWorkspace("/remote/work", makeSandbox("vm"), "on")
    const adapter = buildMicrovmExec({ pool })
    await adapter.preflight?.("runtime:a", "/remote/work")

    await expect(
      adapter.execute("runtime:a", {
        ...payload(),
        command: { ...payload().command, cwd: "/host" },
      })
    ).rejects.toThrow(/outside the bound remote workspace/)
    await expect(
      adapter.execute("runtime:a", payload({ targetFiles: ["/host/file"] }))
    ).rejects.toThrow(/target file/)
  })

  it.each([
    ["cwd", "/remote/work/../outside"],
    ["target", "/remote/work/sub/../../outside"],
  ] as const)("refuses lexical %s traversal outside the remote workspace", async (kind, path) => {
    const pool = new E2BSandboxPool()
    pool.addWorkspace("/remote/work", makeSandbox("vm"), "on")
    const adapter = buildMicrovmExec({ pool })
    await adapter.preflight?.("runtime:a", "/remote/work")
    const input =
      kind === "cwd"
        ? { ...payload(), command: { ...payload().command, cwd: path } }
        : payload({ targetFiles: [path] })

    await expect(adapter.execute("runtime:a", input)).rejects.toThrow(
      /outside the bound remote workspace/
    )
  })

  it("pipes stdin without appending a newline", async () => {
    const pool = new E2BSandboxPool()
    const vm = makeSandbox("vm")
    pool.addWorkspace("/remote/work", vm, "on")
    const adapter = buildMicrovmExec({ pool })
    await adapter.preflight?.("runtime:a", "/remote/work")
    const input = payload()
    input.command.stdin = "exact content"

    await adapter.execute("runtime:a", input)

    expect(vm.exec.mock.calls[0][0].cmd).toContain("printf %s 'exact content' |")
    expect(vm.exec.mock.calls[0][0].cmd).not.toContain("<<<")
  })

  it("returns a deny-shaped result when the live sandbox exec fails", async () => {
    const pool = new E2BSandboxPool()
    const vm = makeSandbox("vm")
    vm.exec.mockRejectedValueOnce(new Error("operation timed out"))
    pool.addWorkspace("/remote/work", vm, "on")
    const adapter = buildMicrovmExec({ pool })
    await adapter.preflight?.("runtime:a", "/remote/work")

    await expect(adapter.execute("runtime:a", payload())).resolves.toMatchObject({
      exit_code: -1,
      timed_out: true,
      stderr: "operation timed out",
    })
  })
})
