import {
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  MAX_TIMEOUT_MS,
  runShellLine,
  truncateToBytes,
} from "./execute"
import type { ResolvedShell } from "./types"
import { CompanionError } from "@/lib/tauri/transport-companion"

const zsh: ResolvedShell = { path: "/bin/zsh", kind: "zsh", source: "setting" }

const okResult = (over = {}) => ({
  stdout: "hi",
  stderr: "",
  exitCode: 0,
  timedOut: false,
  ...over,
})

describe("truncateToBytes", () => {
  it("leaves short text alone", () => {
    expect(truncateToBytes("hello", 100)).toEqual({ text: "hello", truncated: false })
  })

  it("caps by BYTES, not characters", () => {
    // 4 CJK characters = 12 UTF-8 bytes.
    const out = truncateToBytes("你好世界", 6)
    expect(out.truncated).toBe(true)
    expect(out.text).toBe("你好")
  })

  it("never emits a split character", () => {
    const out = truncateToBytes("你好", 4)
    expect(out.text).toBe("你")
    expect(out.text).not.toContain("�")
  })

  it("treats an exact fit as untruncated", () => {
    expect(truncateToBytes("abc", 3)).toEqual({ text: "abc", truncated: false })
  })
})

describe("runShellLine", () => {
  it("hands the line to the CONFIGURED shell, not the host's platform shell", async () => {
    const exec = jest.fn().mockResolvedValue(okResult())
    await runShellLine({
      line: "ls -la",
      cwd: "/work",
      shell: zsh,
      availability: "full",
      exec,
    })
    expect(exec).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "/bin/zsh",
        args: ["-lc", "ls -la"],
        cwd: "/work",
        shell: false,
      })
    )
  })

  it("applies the default timeout and clamps an oversized one", async () => {
    const exec = jest.fn().mockResolvedValue(okResult())
    await runShellLine({ line: "ls", cwd: "/w", shell: zsh, availability: "full", exec })
    expect(exec.mock.calls[0][0].timeoutMs).toBe(DEFAULT_TIMEOUT_MS)

    await runShellLine({
      line: "ls",
      cwd: "/w",
      shell: zsh,
      availability: "full",
      timeoutMs: 60 * 60_000,
      exec,
    })
    expect(exec.mock.calls[1][0].timeoutMs).toBe(MAX_TIMEOUT_MS)
  })

  it("caps oversized output and flags the truncation", async () => {
    const exec = jest
      .fn()
      .mockResolvedValue(
        okResult({ stdout: "x".repeat(MAX_OUTPUT_BYTES + 500), stderr: "y".repeat(10) })
      )
    const out = await runShellLine({
      line: "cat big",
      cwd: "/w",
      shell: zsh,
      availability: "full",
      exec,
    })
    expect(out).toMatchObject({ ok: true, stdoutTruncated: true, stderrTruncated: false })
    if (out.ok) expect(out.stdout.length).toBe(MAX_OUTPUT_BYTES)
  })

  it("reports a timeout with a null exit code", async () => {
    const exec = jest.fn().mockResolvedValue(okResult({ timedOut: true, exitCode: 0 }))
    const out = await runShellLine({
      line: "sleep 999",
      cwd: "/w",
      shell: zsh,
      availability: "full",
      exec,
    })
    expect(out).toMatchObject({ ok: true, timedOut: true, exitCode: null })
  })

  it("refuses without a host rather than throwing", async () => {
    const exec = jest.fn()
    const out = await runShellLine({
      line: "ls",
      cwd: "/w",
      shell: zsh,
      availability: "static-only",
      exec,
    })
    expect(out).toMatchObject({ ok: false, reason: "no-host" })
    expect(exec).not.toHaveBeenCalled()
  })

  it("refuses when the host does not have the configured shell", async () => {
    const exec = jest.fn()
    const out = await runShellLine({
      line: "ls",
      cwd: "/w",
      shell: zsh,
      availability: "shell-unavailable",
      exec,
    })
    expect(out).toMatchObject({ ok: false, reason: "shell-unavailable" })
    expect(exec).not.toHaveBeenCalled()
  })

  it("runs an unclassified shell with the universal -c form", async () => {
    // Refusing `unknown` would take `!` away from every ksh/ash/csh/elvish
    // user — the exact people whose configured shell this module exists to
    // honour. `-c <string>` is the invocation all of them accept.
    const exec = jest.fn().mockResolvedValue({
      stdout: "hi",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    })
    const out = await runShellLine({
      line: "ls",
      cwd: "/w",
      shell: { path: "/opt/xsh", kind: "unknown", source: "setting" },
      availability: "full",
      exec,
    })
    expect(out).toMatchObject({ ok: true, stdout: "hi" })
    expect(exec).toHaveBeenCalledWith(
      expect.objectContaining({ command: "/opt/xsh", args: ["-c", "ls"], shell: false })
    )
  })

  it("refuses an empty line", async () => {
    const exec = jest.fn()
    const out = await runShellLine({
      line: "   ",
      cwd: "/w",
      shell: zsh,
      availability: "full",
      exec,
    })
    expect(out).toMatchObject({ ok: false, reason: "empty-command" })
    expect(exec).not.toHaveBeenCalled()
  })

  it("surfaces a transport failure as a result, never a throw", async () => {
    const exec = jest.fn().mockRejectedValue(new Error("host went away"))
    const out = await runShellLine({
      line: "ls",
      cwd: "/w",
      shell: zsh,
      availability: "full",
      exec,
    })
    expect(out).toMatchObject({ ok: false, reason: "failed", detail: "host went away" })
  })

  it("obtains a host lease and retries a paired execution after interactive refusal", async () => {
    const exec = jest
      .fn()
      .mockRejectedValueOnce(new Error("interactive_approval_required"))
      .mockResolvedValueOnce(okResult())
    const issueLease = jest.fn().mockResolvedValue({
      token: "lease-token",
      operations: ["terminal_exec"],
      expiresAt: Date.now() + 60_000,
    })

    const out = await runShellLine({
      line: "pwd",
      cwd: "/w",
      shell: zsh,
      availability: "full",
      exec,
      issueLease,
    })

    expect(out).toMatchObject({ ok: true, stdout: "hi" })
    expect(issueLease).toHaveBeenCalledWith(["terminal_exec"])
    expect(exec).toHaveBeenNthCalledWith(2, expect.objectContaining({ adminLease: "lease-token" }))
  })

  it("uses the structured Companion error code to detect an interactive refusal", async () => {
    const exec = jest
      .fn()
      .mockRejectedValueOnce(
        new CompanionError({
          code: "interactive_approval_required",
          message: "This operation needs approval",
          retryable: false,
        })
      )
      .mockResolvedValueOnce(okResult())
    const issueLease = jest.fn().mockResolvedValue({
      token: "lease-token",
      operations: ["terminal_exec"],
      expiresAt: Date.now() + 60_000,
    })

    const out = await runShellLine({
      line: "pwd",
      cwd: "/w",
      shell: zsh,
      availability: "full",
      exec,
      issueLease,
    })

    expect(out).toMatchObject({ ok: true, stdout: "hi" })
    expect(issueLease).toHaveBeenCalledWith(["terminal_exec"])
  })
})
