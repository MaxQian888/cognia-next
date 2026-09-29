import { execFile } from "node:child_process"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

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
    expect(a.close).not.toHaveBeenCalled()
    expect(b.close).not.toHaveBeenCalled()

    await pool.removeWorkspace("/remote/a")
    expect(a.close).toHaveBeenCalledTimes(1)
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

  it("caps each E2B output stream on a UTF-8 boundary and marks truncation", async () => {
    const pool = new E2BSandboxPool()
    const vm = makeSandbox("vm")
    vm.exec.mockResolvedValueOnce({
      stdout: `aa${"😀".repeat(300_000)}`,
      stderr: `aaa${"😀".repeat(300_000)}`,
      exitCode: 0,
    })
    pool.addWorkspace("/remote/work", vm, "on")
    const adapter = buildMicrovmExec({ pool })
    await adapter.preflight?.("runtime:a", "/remote/work")

    const result = await adapter.execute("runtime:a", payload())

    expect(new TextEncoder().encode(result.stdout).length).toBeLessThanOrEqual(1_000_000)
    expect(new TextEncoder().encode(result.stderr).length).toBeLessThanOrEqual(1_000_000)
    expect(result.stdout.endsWith("... (truncated)")).toBe(true)
    expect(result.stderr.endsWith("... (truncated)")).toBe(true)
    expect(result.stdout).not.toContain("�")
    expect(result.stderr).not.toContain("�")
    expect(result.stdout_truncated).toBe(true)
    expect(result.stderr_truncated).toBe(true)
  })

  it("attests network-off confinement only for an instance created without egress", async () => {
    const pool = new E2BSandboxPool()
    pool.addWorkspace("/remote/off", makeSandbox("vm-off"), "off")
    pool.addWorkspace("/remote/on", makeSandbox("vm-on"), "on")
    const adapter = buildMicrovmExec({ pool })
    await adapter.preflight?.("runtime:off", "/remote/off")
    await adapter.preflight?.("runtime:on", "/remote/on")

    const off = await adapter.execute("runtime:off", {
      ...payload({ network: "off" }),
      command: { ...payload().command, cwd: "/remote/off" },
    })
    const on = await adapter.execute("runtime:on", {
      ...payload(),
      command: { ...payload().command, cwd: "/remote/on" },
    })
    expect(off.confinement).toEqual({
      networkEnforced: true,
      backend: "e2b",
      maxMemoryMb: null,
      maxCpuSeconds: null,
      maxProcesses: null,
      platform: "linux",
    })
    expect(on.confinement).toMatchObject({ networkEnforced: false, backend: "e2b" })

    // A failed exec is still a call that ran on that instance.
    const vm = makeSandbox("vm-fail")
    vm.exec.mockRejectedValueOnce(new Error("boom"))
    pool.addWorkspace("/remote/fail", vm, "off")
    await adapter.preflight?.("runtime:fail", "/remote/fail")
    await expect(
      adapter.execute("runtime:fail", {
        ...payload({ network: "off" }),
        command: { ...payload().command, cwd: "/remote/fail" },
      })
    ).resolves.toMatchObject({ exit_code: -1, confinement: { networkEnforced: true } })
  })

  describe("accepts", () => {
    it("refuses an ordinary local worktree without claiming anything", async () => {
      const pool = new E2BSandboxPool()
      pool.addWorkspace("/remote/work", makeSandbox("vm"), "off")
      const adapter = buildMicrovmExec({ pool })

      expect(adapter.accepts?.("runtime:a", "/Users/me/checkout")).toMatchObject({
        accepted: false,
        code: "workspace-unavailable",
        reason: expect.stringMatching(/no live E2B workspace/),
      })
      expect(adapter.accepts?.("runtime:a", "")).toMatchObject({
        accepted: false,
        code: "workspace-unavailable",
      })
      // Nothing was claimed: the pool still has no owner for the ref.
      expect(pool.snapshot()[0].ownerRefs).toEqual([])
    })

    it("accepts exactly what preflight would claim, and still claims nothing", async () => {
      const pool = new E2BSandboxPool()
      pool.addWorkspace("/remote/work", makeSandbox("vm"), "off")
      const adapter = buildMicrovmExec({ pool })

      expect(adapter.accepts?.("runtime:a", "/remote/work", { network: "off" })).toEqual({
        accepted: true,
      })
      expect(pool.snapshot()[0].ownerRefs).toEqual([])

      // Another session owns it: preflight would refuse, so accepts does too.
      await adapter.preflight?.("runtime:b", "/remote/work", "session:b")
      expect(adapter.accepts?.("runtime:a", "/remote/work")).toMatchObject({
        accepted: false,
        code: "workspace-unavailable",
        reason: expect.stringMatching(/owned by another runtime session/),
      })
      expect(adapter.accepts?.("runtime:c", "/remote/work", { ownerGroup: "session:b" })).toEqual({
        accepted: true,
      })
    })

    it("refuses a caller that needs network off on an instance created with egress", async () => {
      const pool = new E2BSandboxPool()
      pool.addWorkspace("/remote/work", makeSandbox("vm"), "on")
      const adapter = buildMicrovmExec({ pool })
      expect(adapter.accepts?.("runtime:a", "/remote/work", { network: "off" })).toMatchObject({
        accepted: false,
        code: "policy-not-attested",
        reason: expect.stringMatching(/network=on/),
      })
      expect(adapter.accepts?.("runtime:a", "/remote/work", { network: "on" })).toEqual({
        accepted: true,
      })
      expect(adapter.accepts?.("runtime:a", "/remote/work")).toEqual({ accepted: true })
    })
  })

  describe("readFile", () => {
    function scripted(exitCode: number, stdout = "", stderr = "") {
      const vm = makeSandbox("vm")
      vm.exec.mockResolvedValue({ stdout, stderr, exitCode })
      return vm
    }

    async function adapterWith(vm: ReturnType<typeof makeSandbox>) {
      const pool = new E2BSandboxPool()
      pool.addWorkspace("/remote/work", vm, "off")
      const adapter = buildMicrovmExec({ pool })
      await adapter.preflight?.("runtime:a", "/remote/work")
      return adapter
    }

    it("reads the file inside the bound machine, with the cap in the command", async () => {
      const vm = scripted(0, "<testsuites/>")
      const adapter = await adapterWith(vm)
      await expect(
        adapter.readFile?.("runtime:a", "/remote/work/reports/junit.xml", 4096)
      ).resolves.toEqual({ kind: "ok", content: "<testsuites/>" })
      const cmd = vm.exec.mock.calls[0][0].cmd
      expect(cmd).toContain("'/remote/work/reports/junit.xml'")
      expect(cmd).toContain("-le 4096")
      expect(cmd).toContain("realpath -- '/remote/work'")
    })

    it.each([
      [64, { kind: "missing" }],
      [65, { kind: "too_large" }],
      [66, { kind: "refused", code: "workspace-boundary" }],
      [67, { kind: "refused", code: "NOT_A_FILE" }],
      [2, { kind: "refused", code: "READ_FAILED" }],
    ])("maps exit %i to its answer", async (exitCode, expected) => {
      const adapter = await adapterWith(scripted(exitCode, "", "cat: denied"))
      await expect(
        adapter.readFile?.("runtime:a", "/remote/work/report.json", 10)
      ).resolves.toMatchObject(expected)
    })

    it("refuses a path outside the workspace before asking the machine", async () => {
      const vm = scripted(0, "secret")
      const adapter = await adapterWith(vm)
      await expect(
        adapter.readFile?.("runtime:a", "/remote/work/../../etc/passwd", 10)
      ).resolves.toMatchObject({ kind: "refused", code: "workspace-boundary" })
      expect(vm.exec).not.toHaveBeenCalled()
    })

    it("answers refused when the machine cannot be reached, and needs a bound owner", async () => {
      const vm = makeSandbox("vm")
      vm.exec.mockRejectedValueOnce(new Error("sandbox gone"))
      const adapter = await adapterWith(vm)
      await expect(
        adapter.readFile?.("runtime:a", "/remote/work/report.json", 10)
      ).resolves.toMatchObject({ kind: "refused", code: "READ_FAILED", message: "sandbox gone" })
      await expect(
        adapter.readFile?.("runtime:unbound", "/remote/work/report.json", 10)
      ).rejects.toMatchObject({ code: "runtime-unbound" })
    })

    const posixOnly = process.platform === "win32" ? it.skip : it
    posixOnly("runs a command bash really executes with the promised answers", async () => {
      const dir = await mkdtemp(join(tmpdir(), "e2b-read-"))
      try {
        const root = join(dir, "work")
        await mkdir(join(root, "reports"), { recursive: true })
        await writeFile(join(root, "reports", "junit.xml"), "<ok/>")
        await writeFile(join(root, "big.json"), "x".repeat(32))
        await writeFile(join(dir, "outside.txt"), "secret")
        await symlink(join(dir, "outside.txt"), join(root, "escape.txt"))
        const bash = {
          id: "local-bash",
          exec: jest.fn(
            (opts: { cmd: string }) =>
              new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
                execFile("bash", ["-c", opts.cmd], (error, stdout, stderr) => {
                  const code = error ? ((error as { code?: number }).code ?? 1) : 0
                  resolve({ stdout, stderr, exitCode: typeof code === "number" ? code : 1 })
                })
              })
          ),
          close: jest.fn(async () => undefined),
        }
        const pool = new E2BSandboxPool()
        pool.addWorkspace(root, bash, "off")
        const adapter = buildMicrovmExec({ pool })
        await adapter.preflight?.("runtime:a", root)

        await expect(
          adapter.readFile?.("runtime:a", `${root}/reports/junit.xml`, 1024)
        ).resolves.toEqual({ kind: "ok", content: "<ok/>" })
        await expect(
          adapter.readFile?.("runtime:a", `${root}/reports/none.xml`, 1024)
        ).resolves.toEqual({ kind: "missing" })
        await expect(adapter.readFile?.("runtime:a", `${root}/big.json`, 16)).resolves.toEqual({
          kind: "too_large",
        })
        await expect(adapter.readFile?.("runtime:a", `${root}/big.json`, 32)).resolves.toEqual({
          kind: "ok",
          content: "x".repeat(32),
        })
        await expect(
          adapter.readFile?.("runtime:a", `${root}/escape.txt`, 1024)
        ).resolves.toMatchObject({ kind: "refused", code: "workspace-boundary" })
        await expect(
          adapter.readFile?.("runtime:a", `${root}/reports`, 1024)
        ).resolves.toMatchObject({ kind: "refused", code: "NOT_A_FILE" })
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })
  })
})
