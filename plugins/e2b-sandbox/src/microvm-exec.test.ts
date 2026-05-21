/**
 * ADR-0028 / T4 — e2b microvm-exec adapter unit tests.
 *
 * The default factory pulls `@e2b/sdk` via dynamic import, which can't
 * resolve in jsdom. Tests always pass a `sandboxFactory` override so we
 * stay off that path.
 */

import { buildMicrovmExec } from "./microvm-exec"
import type { E2BSandboxFacade } from "./workspace-backend"

function makeSandbox(overrides: Partial<E2BSandboxFacade> = {}): {
  sandbox: E2BSandboxFacade
  closed: { count: number }
} {
  const closed = { count: 0 }
  const { exec: execOverride, close: closeOverride, id: idOverride } = overrides
  const sandbox: E2BSandboxFacade = {
    id: idOverride ?? "fake-sandbox",
    async exec(opts) {
      return execOverride ? execOverride(opts) : { stdout: "", stderr: "", exitCode: 0 }
    },
    async close() {
      closed.count += 1
      if (closeOverride) await closeOverride()
    },
  }
  return { sandbox, closed }
}

describe("buildMicrovmExec", () => {
  it("runs the payload's argv through bash and returns the result shape", async () => {
    const recordedCommands: string[] = []
    const { sandbox } = makeSandbox({
      exec: async (opts) => {
        recordedCommands.push(opts.cmd)
        return { stdout: "hello\n", stderr: "", exitCode: 0 }
      },
    })
    const exec = buildMicrovmExec({
      sandboxFactory: async () => sandbox,
      now: () => 1000,
    })
    const result = await exec({
      tool: "sandbox_bash",
      command: {
        argv: ["echo", "hello"],
        cwd: "/work",
        env: { FOO: "bar" },
        stdin: null,
        timeout: 30,
      },
      request: {
        writable: ["/work"],
        readable: [],
        targetFiles: [],
        maxCpuSeconds: 0,
        maxMemoryMb: 0,
        network: "off",
        networkHosts: [],
      },
    })
    expect(result.exit_code).toBe(0)
    expect(result.stdout).toBe("hello\n")
    expect(result.timed_out).toBe(false)
    expect(recordedCommands).toHaveLength(1)
    // Env vars exported, argv shell-quoted.
    expect(recordedCommands[0]).toContain("export FOO='bar'")
    expect(recordedCommands[0]).toContain("'echo' 'hello'")
  })

  it("escapes shell metacharacters in argv", async () => {
    const { sandbox } = makeSandbox({
      exec: async (opts) => ({
        stdout: opts.cmd,
        stderr: "",
        exitCode: 0,
      }),
    })
    const exec = buildMicrovmExec({ sandboxFactory: async () => sandbox })
    const result = await exec({
      tool: "sandbox_bash",
      command: {
        argv: ["sh", "-c", `echo "$EVIL"; rm -rf /`],
        cwd: "/",
        env: {},
        stdin: null,
        timeout: 0,
      },
      request: {
        writable: [],
        readable: [],
        targetFiles: [],
        maxCpuSeconds: 0,
        maxMemoryMb: 0,
        network: "off",
        networkHosts: [],
      },
    })
    // The dangerous chars survive only inside single quotes — they
    // cannot break out of the quoted segment.
    expect(result.stdout).toContain(`'sh' '-c' 'echo "$EVIL"; rm -rf /'`)
  })

  it("returns a Deny-shaped result when the sandbox throws", async () => {
    const { sandbox, closed } = makeSandbox({
      exec: async () => {
        throw new Error("vm exploded")
      },
    })
    const exec = buildMicrovmExec({
      sandboxFactory: async () => sandbox,
      now: () => 0,
    })
    const result = await exec({
      tool: "sandbox_bash",
      command: {
        argv: ["echo"],
        cwd: "/",
        env: {},
        stdin: null,
        timeout: 0,
      },
      request: {
        writable: [],
        readable: [],
        targetFiles: [],
        maxCpuSeconds: 0,
        maxMemoryMb: 0,
        network: "off",
        networkHosts: [],
      },
    })
    expect(result.exit_code).toBe(-1)
    expect(result.stderr).toContain("vm exploded")
    expect(closed.count).toBe(1)
  })

  it("flags timed_out when the error message mentions a timeout", async () => {
    const { sandbox } = makeSandbox({
      exec: async () => {
        throw new Error("operation timed out after 30s")
      },
    })
    const exec = buildMicrovmExec({ sandboxFactory: async () => sandbox })
    const result = await exec({
      tool: "sandbox_bash",
      command: {
        argv: ["true"],
        cwd: "/",
        env: {},
        stdin: null,
        timeout: 1,
      },
      request: {
        writable: [],
        readable: [],
        targetFiles: [],
        maxCpuSeconds: 0,
        maxMemoryMb: 0,
        network: "off",
        networkHosts: [],
      },
    })
    expect(result.timed_out).toBe(true)
  })

  it("always closes the sandbox on the way out", async () => {
    const { sandbox, closed } = makeSandbox()
    const exec = buildMicrovmExec({ sandboxFactory: async () => sandbox })
    await exec({
      tool: "sandbox_bash",
      command: {
        argv: ["true"],
        cwd: "/",
        env: {},
        stdin: null,
        timeout: 0,
      },
      request: {
        writable: [],
        readable: [],
        targetFiles: [],
        maxCpuSeconds: 0,
        maxMemoryMb: 0,
        network: "off",
        networkHosts: [],
      },
    })
    expect(closed.count).toBe(1)
  })
})
