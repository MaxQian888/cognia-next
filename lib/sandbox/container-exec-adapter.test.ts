import type { MicrovmExecPayload } from "@cognia/plugin-sdk/api/sandbox"

import {
  __setContainerExecForTesting,
  CONTAINER_DEFAULT_TIMEOUT_SECONDS,
  createContainerExecAdapter,
  getContainerExec,
  type TaskShellResultWire,
} from "./container-exec-adapter"

const placement = {
  kind: "container",
  spec: { specDigest: "sha256:abc", egress: { tier: "off" } },
  isolationMandatory: true,
} as never

function payload(overrides: Partial<MicrovmExecPayload["command"]> = {}): MicrovmExecPayload {
  return {
    tool: "sandbox_bash",
    command: {
      argv: ["bash", "-c", "ls"],
      cwd: "/workspaces/p/src",
      env: { LANG: "C" },
      stdin: null,
      timeout: 30,
      ...overrides,
    },
    request: {
      writable: [],
      readable: [],
      targetFiles: [],
      maxCpuSeconds: 0,
      maxMemoryMb: 0,
      network: "off",
    },
  } as MicrovmExecPayload
}

function wire(overrides: Partial<TaskShellResultWire> = {}): TaskShellResultWire {
  return {
    exitCode: 0,
    stdout: "out",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    durationMs: 12,
    provider: "local",
    containerId: "runtime-1",
    tier: "container",
    ...overrides,
  }
}

function setup() {
  const call = jest.fn(async (command: string, _args: Record<string, unknown>) =>
    command === "environment_task_shell_exec" ? wire() : { removed: [] }
  )
  const resolvePlacement = jest.fn(async () => placement)
  const adapter = createContainerExecAdapter({
    call: call as never,
    resolvePlacement,
  })
  return { adapter, call, resolvePlacement }
}

afterEach(() => __setContainerExecForTesting(undefined))

describe("createContainerExecAdapter", () => {
  it("claims the session's placement at preflight and runs each command there", async () => {
    const { adapter, call, resolvePlacement } = setup()
    await adapter.preflight!("ref-1", "/workspaces/p", "s1")
    expect(resolvePlacement).toHaveBeenCalledWith({
      sessionId: "s1",
      workspaceRoot: "/workspaces/p",
    })

    const result = await adapter.execute("ref-1", payload({ stdin: "input" }))

    expect(call).toHaveBeenCalledWith("environment_task_shell_exec", {
      placement,
      owner: "session:s1",
      workspaceRoot: "/workspaces/p",
      cwd: "/workspaces/p/src",
      argv: ["bash", "-c", "ls"],
      env: { LANG: "C" },
      stdin: "input",
      timeoutMs: 30_000,
    })
    expect(result).toEqual({
      exit_code: 0,
      stdout: "out",
      stderr: "",
      duration: 12,
      timed_out: false,
      confinement: { networkEnforced: true, backend: "container:container", platform: "linux" },
    })
  })

  it("defaults the cwd and timeout and omits absent input", async () => {
    const { adapter, call } = setup()
    await adapter.preflight!("ref-1", "/workspaces/p", "s1")
    await adapter.execute("ref-1", payload({ cwd: "", timeout: 0 }))
    const args = call.mock.calls[0][1]
    expect(args.cwd).toBe("/workspaces/p")
    expect(args.timeoutMs).toBe(CONTAINER_DEFAULT_TIMEOUT_SECONDS * 1000)
    expect(args).not.toHaveProperty("stdin")
  })

  it("reports truncation, a timeout without status and an environment with egress", async () => {
    const call = jest.fn(async () =>
      wire({ exitCode: null, timedOut: true, stdoutTruncated: true, stderrTruncated: true })
    )
    const adapter = createContainerExecAdapter({
      call: call as never,
      resolvePlacement: async () =>
        ({ kind: "container", spec: { egress: { tier: "allowlist" } } }) as never,
    })
    await adapter.preflight!("ref-1", "/w", "s1")
    const result = await adapter.execute("ref-1", payload())
    expect(result.exit_code).toBe(124)
    expect(result.timed_out).toBe(true)
    expect(result.stdout_truncated).toBe(true)
    expect(result.stderr_truncated).toBe(true)
    expect(result.confinement?.networkEnforced).toBe(false)
  })

  it("refuses without a workspace, a session, or a bound ref, and never calls the Host", async () => {
    const { adapter, call, resolvePlacement } = setup()
    await expect(adapter.preflight!("ref-1", undefined, "s1")).rejects.toMatchObject({
      code: "placement-unavailable",
    })
    await expect(adapter.preflight!("ref-1", "/w", undefined)).rejects.toMatchObject({
      code: "placement-unavailable",
    })
    await expect(adapter.execute("ref-1", payload())).rejects.toMatchObject({
      code: "runtime-released",
    })
    expect(resolvePlacement).not.toHaveBeenCalled()
    expect(call).not.toHaveBeenCalled()
  })

  it("a refused placement leaves nothing bound", async () => {
    const adapter = createContainerExecAdapter({
      call: jest.fn() as never,
      resolvePlacement: async () => {
        throw new Error("environment_approval_pending")
      },
    })
    await expect(adapter.preflight!("ref-1", "/w", "s1")).rejects.toThrow(
      "environment_approval_pending"
    )
    await expect(adapter.execute("ref-1", payload())).rejects.toMatchObject({
      code: "runtime-released",
    })
  })

  it("releases every runtime a generation used, once, by provider", async () => {
    const { adapter, call } = setup()
    await adapter.preflight!("ref-1", "/w", "s1")
    call.mockResolvedValueOnce(wire({ containerId: "a" }) as never)
    await adapter.execute("ref-1", payload())
    call.mockResolvedValueOnce(wire({ containerId: "a" }) as never)
    await adapter.execute("ref-1", payload())
    call.mockResolvedValueOnce(wire({ containerId: "b", provider: "local-2" }) as never)
    await adapter.execute("ref-1", payload())

    await adapter.release!("ref-1")
    const releases = call.mock.calls.filter(([name]) => name === "environment_task_shell_release")
    expect(releases.map(([, args]) => args)).toEqual([
      { provider: "local", containerIds: ["a"] },
      { provider: "local-2", containerIds: ["b"] },
    ])
    await adapter.release!("ref-1")
    expect(
      call.mock.calls.filter(([name]) => name === "environment_task_shell_release")
    ).toHaveLength(2)
  })

  it("releases a runtime first seen after its generation was released", async () => {
    const { adapter, call } = setup()
    await adapter.preflight!("ref-1", "/w", "s1")
    let finish!: (value: TaskShellResultWire) => void
    call.mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve as never)) as never
    )
    const running = adapter.execute("ref-1", payload())
    await adapter.release!("ref-1")
    finish(wire({ containerId: "late" }))
    await running
    expect(call).toHaveBeenCalledWith("environment_task_shell_release", {
      provider: "local",
      containerIds: ["late"],
    })
  })

  it("surfaces a failed release and dispose releases every binding", async () => {
    const { adapter, call } = setup()
    await adapter.preflight!("ref-1", "/w", "s1")
    await adapter.execute("ref-1", payload())
    call.mockRejectedValueOnce(new Error("host gone"))
    await expect(adapter.release!("ref-1")).rejects.toThrow("host gone")

    await adapter.preflight!("ref-2", "/w", "s2")
    await adapter.execute("ref-2", payload())
    await adapter.dispose!()
    expect(call).toHaveBeenLastCalledWith("environment_task_shell_release", {
      provider: "local",
      containerIds: ["runtime-1"],
    })
  })
})

describe("getContainerExec", () => {
  it("is null outside a headless Host", () => {
    __setContainerExecForTesting(undefined)
    expect(getContainerExec()).toBeNull()
  })

  it("is an adapter on a headless Host", () => {
    __setContainerExecForTesting(undefined)
    const globals = globalThis as Record<string, unknown>
    globals.__COGNIA_HEADLESS__ = true
    try {
      const adapter = getContainerExec()
      expect(adapter).not.toBeNull()
      expect(getContainerExec()).toBe(adapter)
    } finally {
      delete globals.__COGNIA_HEADLESS__
    }
  })
})
