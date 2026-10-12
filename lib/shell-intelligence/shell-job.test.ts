import { MAX_OUTPUT_BYTES } from "./execute"
import {
  appendTail,
  describeJobStatus,
  EMPTY_TAIL,
  fenceFor,
  formatShellJobResult,
  isMissingCommandError,
  keepTailBytes,
  startShellJob,
  type ShellJobCopy,
} from "./shell-job"
import type { ResolvedShell } from "./types"
import { CompanionError } from "@/lib/tauri/transport-companion"

const zsh: ResolvedShell = { path: "/bin/zsh", kind: "zsh", source: "setting" }

const copy: ShellJobCopy = {
  header: (command, status) => `$ ${command} (${status})`,
  statusExit: (code) => `exit ${code}`,
  statusKilled: "stopped",
  statusInterrupted: "interrupted",
  statusFailed: "failed",
  noOutput: "(no output)",
  truncated: "(last 64 KB)",
  movedToBackground: (command) => `${command} moved`,
  lost: (command, error) => `${command} lost: ${error}`,
}

const job = { id: "job-1", status: "running" }

describe("startShellJob", () => {
  it("spawns the line under the CONFIGURED shell, owned by the conversation", async () => {
    const spawn = jest.fn().mockResolvedValue(job)
    const out = await startShellJob({
      sessionId: "sess-1",
      line: "  pnpm build  ",
      cwd: "/work",
      shell: zsh,
      availability: "full",
      label: "Chat command",
      spawn,
    })
    expect(out).toEqual({ ok: true, job })
    expect(spawn).toHaveBeenCalledWith({
      sessionId: "sess-1",
      command: "pnpm build",
      program: "/bin/zsh",
      args: ["-lc", "pnpm build"],
      cwd: "/work",
      label: "Chat command",
    })
  })

  it("refuses by name before reaching the Host", async () => {
    const spawn = jest.fn()
    const base = { sessionId: "s", cwd: "/w", shell: zsh, spawn }
    await expect(
      startShellJob({ ...base, line: " ", availability: "full" })
    ).resolves.toMatchObject({ ok: false, reason: "empty-command" })
    await expect(
      startShellJob({ ...base, line: "ls", availability: "static-only" })
    ).resolves.toMatchObject({ ok: false, reason: "no-host" })
    await expect(
      startShellJob({ ...base, line: "ls", availability: "shell-unavailable" })
    ).resolves.toMatchObject({ ok: false, reason: "shell-unavailable" })
    expect(spawn).not.toHaveBeenCalled()
  })

  it("retries with a lease for the spawn command after an approval refusal", async () => {
    const spawn = jest
      .fn()
      .mockRejectedValueOnce(new Error("interactive_approval_required"))
      .mockResolvedValueOnce(job)
    const issueLease = jest
      .fn()
      .mockResolvedValue({ token: "lease-1", operations: [], expiresAt: Date.now() + 60_000 })
    const out = await startShellJob({
      sessionId: "s",
      line: "ls",
      cwd: "/w",
      shell: zsh,
      availability: "full",
      spawn,
      issueLease,
    })
    expect(out).toEqual({ ok: true, job })
    expect(issueLease).toHaveBeenCalledWith(["background_job_spawn_session"])
    expect(spawn).toHaveBeenLastCalledWith(expect.objectContaining({ adminLease: "lease-1" }))
  })

  it("reports a Host without the job command as job-unavailable so the caller falls back", async () => {
    const spawn = jest.fn().mockRejectedValue(
      new CompanionError({
        code: "unknown_command",
        message: "the requested command is not registered",
        retryable: false,
      })
    )
    const out = await startShellJob({
      sessionId: "s",
      line: "ls",
      cwd: "/w",
      shell: zsh,
      availability: "full",
      spawn,
    })
    expect(out).toMatchObject({ ok: false, reason: "job-unavailable" })
  })

  it("keeps an ordinary spawn failure a failure", async () => {
    const out = await startShellJob({
      sessionId: "s",
      line: "ls",
      cwd: "/w",
      shell: zsh,
      availability: "full",
      spawn: jest.fn().mockRejectedValue(new Error("at most 8 background jobs")),
    })
    expect(out).toMatchObject({ ok: false, reason: "failed", detail: "at most 8 background jobs" })
  })
})

describe("isMissingCommandError", () => {
  it("recognises each layer's spelling of an unknown command", () => {
    expect(isMissingCommandError({ code: "unknown_command" })).toBe(true)
    expect(isMissingCommandError(new Error("Command background_job_spawn_session not found"))).toBe(
      true
    )
    expect(isMissingCommandError(new Error("command_transport_forbidden"))).toBe(true)
    expect(isMissingCommandError({ code: "no_host_transport" })).toBe(true)
    expect(isMissingCommandError(new Error("invalid chat session id"))).toBe(false)
  })
})

describe("keepTailBytes / appendTail", () => {
  it("keeps the END of the output, by bytes", () => {
    expect(keepTailBytes("abcdef", 3)).toEqual({ text: "def", truncated: true })
    expect(keepTailBytes("abc", 3)).toEqual({ text: "abc", truncated: false })
  })

  it("never starts inside a multi-byte character", () => {
    // 3 CJK characters = 9 bytes; a 7-byte tail must drop the split one.
    const out = keepTailBytes("你好世", 7)
    expect(out).toEqual({ text: "好世", truncated: true })
    expect(out.text).not.toContain("�")
  })

  it("stays truncated once anything was dropped", () => {
    let tail = appendTail(EMPTY_TAIL, "aaaa", 4)
    expect(tail).toEqual({ text: "aaaa", truncated: false })
    tail = appendTail(tail, "bb", 4)
    expect(tail).toEqual({ text: "aabb", truncated: true })
    tail = appendTail(tail, "", 4)
    expect(tail.truncated).toBe(true)
  })

  it("defaults to the 64 KiB display cap", () => {
    const big = "x".repeat(MAX_OUTPUT_BYTES + 10)
    expect(new TextEncoder().encode(appendTail(EMPTY_TAIL, big).text).length).toBe(MAX_OUTPUT_BYTES)
  })
})

describe("formatShellJobResult", () => {
  it("states the exit code and fences the output", () => {
    const text = formatShellJobResult(copy, {
      command: "ls",
      status: "exited",
      exitCode: 0,
      output: { text: "a\nb\n", truncated: false },
    })
    expect(text).toBe("$ ls (exit 0)\n\n```\na\nb\n```")
  })

  it("names a stop, an interruption and a failed start", () => {
    expect(describeJobStatus(copy, "killed")).toBe("stopped")
    expect(describeJobStatus(copy, "interrupted")).toBe("interrupted")
    expect(describeJobStatus(copy, "failed")).toBe("failed")
    expect(describeJobStatus(copy, "exited")).toBe("exit ?")
  })

  it("says when output was clipped and when there was none", () => {
    expect(
      formatShellJobResult(copy, {
        command: "make",
        status: "exited",
        exitCode: 2,
        output: { text: "tail", truncated: true },
      })
    ).toBe("$ make (exit 2)\n\n(last 64 KB)\n\n```\ntail\n```")
    expect(
      formatShellJobResult(copy, {
        command: "true",
        status: "exited",
        exitCode: 0,
        output: EMPTY_TAIL,
      })
    ).toBe("$ true (exit 0)\n\n(no output)")
  })

  it("cannot be closed early by output that prints a fence", () => {
    expect(fenceFor("```js\ncode\n```")).toBe("````")
    const text = formatShellJobResult(copy, {
      command: "cat README.md",
      status: "exited",
      exitCode: 0,
      output: { text: "```\nx\n```", truncated: false },
    })
    expect(text).toContain("````\n```\nx\n```\n````")
  })
})
