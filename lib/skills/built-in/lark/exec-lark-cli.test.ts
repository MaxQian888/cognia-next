/**
 * Tests for lib/skills/built-in/lark/exec-lark-cli.ts.
 *
 * Mocks node:child_process so the wrapper can be exercised without an
 * actual lark-cli binary on PATH. Auth bridge is bypassed via the
 * `__authOverride` escape hatch on every call.
 */

import { execLarkCli, __setLarkCliBinaryForTests } from "./exec-lark-cli"
import type { LarkAuthBridgeResult } from "./auth-bridge"

const mockExecFile = jest.fn()
jest.mock("node:child_process", () => ({
  execFile: (
    file: string,
    args: readonly string[],
    opts: unknown,
    cb: (err: unknown, result: { stdout: string; stderr: string }) => void
  ) => {
    Promise.resolve(mockExecFile(file, args, opts)).then(
      (r) => cb(null, r),
      (err) => cb(err, { stdout: "", stderr: "" })
    )
  },
}))

const okAuth: LarkAuthBridgeResult = {
  ok: true,
  adapterId: "lark-1",
  identity: "user",
  env: {
    LARK_APP_ID: "cli_x",
    LARK_APP_SECRET: "s-x",
    LARK_USER_ACCESS_TOKEN: "uat-x",
  },
}

beforeEach(() => {
  mockExecFile.mockReset()
  __setLarkCliBinaryForTests("/fake/lark-cli")
})

afterAll(() => {
  __setLarkCliBinaryForTests(null)
})

describe("execLarkCli — happy path", () => {
  it("parses JSON stdout and returns ok", async () => {
    mockExecFile.mockResolvedValue({
      stdout: JSON.stringify({ events: [{ id: "e1" }] }),
      stderr: "",
    })
    const r = await execLarkCli({
      args: ["calendar", "+list-events"],
      __authOverride: okAuth,
    })
    expect(r.status).toBe("ok")
    if (r.status === "ok") {
      expect(r.data).toEqual({ events: [{ id: "e1" }] })
      expect(r.adapterId).toBe("lark-1")
      expect(r.identity).toBe("user")
    }
  })

  it("returns raw string when stdout is not JSON", async () => {
    mockExecFile.mockResolvedValue({ stdout: "hello world\n", stderr: "" })
    const r = await execLarkCli({ args: ["version"], __authOverride: okAuth })
    expect(r.status).toBe("ok")
    if (r.status === "ok") expect(r.data).toBe("hello world")
  })

  it("returns null data for empty stdout", async () => {
    mockExecFile.mockResolvedValue({ stdout: "  \n  ", stderr: "" })
    const r = await execLarkCli({ args: ["noop"], __authOverride: okAuth })
    expect(r.status).toBe("ok")
    if (r.status === "ok") expect(r.data).toBeNull()
  })
})

describe("execLarkCli — argv composition", () => {
  it("prepends --as <identity> when caller omitted it", async () => {
    mockExecFile.mockResolvedValue({ stdout: "{}", stderr: "" })
    await execLarkCli({
      args: ["calendar", "+list-events"],
      __authOverride: okAuth,
    })
    const argv = mockExecFile.mock.calls[0][1] as string[]
    expect(argv.slice(0, 2)).toEqual(["--as", "user"])
    expect(argv).toContain("+list-events")
  })

  it("does not duplicate --as when caller already supplied it", async () => {
    mockExecFile.mockResolvedValue({ stdout: "{}", stderr: "" })
    await execLarkCli({
      args: ["--as", "bot", "calendar", "+list-events"],
      __authOverride: okAuth,
    })
    const argv = mockExecFile.mock.calls[0][1] as string[]
    expect(argv.filter((a) => a === "--as")).toHaveLength(1)
  })

  it("appends --yes when confirmed=true", async () => {
    mockExecFile.mockResolvedValue({ stdout: "{}", stderr: "" })
    await execLarkCli({
      args: ["calendar", "+delete-event"],
      confirmed: true,
      __authOverride: okAuth,
    })
    const argv = mockExecFile.mock.calls[0][1] as string[]
    expect(argv).toContain("--yes")
  })

  it("does not append --yes when confirmed not set", async () => {
    mockExecFile.mockResolvedValue({ stdout: "{}", stderr: "" })
    await execLarkCli({ args: ["calendar", "+x"], __authOverride: okAuth })
    const argv = mockExecFile.mock.calls[0][1] as string[]
    expect(argv).not.toContain("--yes")
  })
})

describe("execLarkCli — env injection", () => {
  it("merges auth env onto process.env", async () => {
    mockExecFile.mockResolvedValue({ stdout: "{}", stderr: "" })
    await execLarkCli({ args: ["calendar"], __authOverride: okAuth })
    const opts = mockExecFile.mock.calls[0][2] as { env: Record<string, string> }
    expect(opts.env.LARK_APP_ID).toBe("cli_x")
    expect(opts.env.LARK_USER_ACCESS_TOKEN).toBe("uat-x")
    // PATH inherited from process.env so the binary itself can resolve deps.
    expect(opts.env.PATH ?? opts.env.Path).toBeDefined()
  })
})

describe("execLarkCli — error paths", () => {
  it("auth_unavailable when bridge returns ok=false", async () => {
    const r = await execLarkCli({
      args: ["x"],
      __authOverride: {
        ok: false,
        reason: "no_adapter",
        message: "no Lark adapter",
      },
    })
    expect(r.status).toBe("error")
    if (r.status === "error") {
      expect(r.reason).toBe("auth_unavailable")
      expect(r.message).toContain("no Lark adapter")
    }
  })

  it("binary_not_found on ENOENT from execFile", async () => {
    mockExecFile.mockRejectedValue({
      code: "ENOENT",
      message: "no such file",
      stderr: "",
    })
    const r = await execLarkCli({ args: ["x"], __authOverride: okAuth })
    expect(r.status).toBe("error")
    if (r.status === "error") expect(r.reason).toBe("binary_not_found")
  })

  it("timeout when killed/SIGTERM", async () => {
    mockExecFile.mockRejectedValue({
      killed: true,
      signal: "SIGTERM",
      stderr: "",
    })
    const r = await execLarkCli({
      args: ["slow"],
      timeoutMs: 1000,
      __authOverride: okAuth,
    })
    expect(r.status).toBe("error")
    if (r.status === "error") expect(r.reason).toBe("timeout")
  })

  it("hitl_required when lark-cli exits with code 10", async () => {
    mockExecFile.mockRejectedValue({
      code: 10,
      stderr: "Confirmation required: pass --yes",
    })
    const r = await execLarkCli({
      args: ["calendar", "+delete-event"],
      __authOverride: okAuth,
    })
    expect(r.status).toBe("error")
    if (r.status === "error") {
      expect(r.reason).toBe("hitl_required")
      expect(r.exitCode).toBe(10)
    }
  })

  it("non_zero_exit for other failures", async () => {
    mockExecFile.mockRejectedValue({
      code: 2,
      stderr: "bad arg",
      message: "command failed",
    })
    const r = await execLarkCli({ args: ["x"], __authOverride: okAuth })
    expect(r.status).toBe("error")
    if (r.status === "error") {
      expect(r.reason).toBe("non_zero_exit")
      expect(r.exitCode).toBe(2)
      expect(r.stderr).toBe("bad arg")
    }
  })
})

describe("execLarkCli — timeout clamping", () => {
  it("clamps timeoutMs above 5min to 5min", async () => {
    mockExecFile.mockResolvedValue({ stdout: "{}", stderr: "" })
    await execLarkCli({
      args: ["x"],
      timeoutMs: 999_999_999,
      __authOverride: okAuth,
    })
    const opts = mockExecFile.mock.calls[0][2] as { timeout: number }
    expect(opts.timeout).toBe(5 * 60 * 1000)
  })

  it("clamps timeoutMs below 1s up to 1s", async () => {
    mockExecFile.mockResolvedValue({ stdout: "{}", stderr: "" })
    await execLarkCli({ args: ["x"], timeoutMs: 50, __authOverride: okAuth })
    const opts = mockExecFile.mock.calls[0][2] as { timeout: number }
    expect(opts.timeout).toBe(1000)
  })
})
