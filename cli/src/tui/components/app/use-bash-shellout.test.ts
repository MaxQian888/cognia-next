/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"

import { useBashShellout } from "./use-bash-shellout"
import type { ShellResult, RunShellOpts } from "../../../agent/run-shell"

const flush = () => new Promise((r) => setTimeout(r, 0))

function makeRunShell(result: ShellResult | Error) {
  const calls: { command: string; opts: RunShellOpts }[] = []
  const run = jest.fn(async (command: string, opts: RunShellOpts) => {
    calls.push({ command, opts })
    if (result instanceof Error) throw result
    return result
  })
  return { run, calls }
}

describe("useBashShellout", () => {
  const ok: ShellResult = { code: 0, stdout: "hi", stderr: "", aborted: false }

  it("starts a run, streams chunks, and posts the final result", async () => {
    const dispatch = jest.fn()
    const { run } = makeRunShell(ok)
    const { result } = renderHook(() => useBashShellout(run, "/repo", dispatch))

    await act(async () => {
      result.current.runBash("echo hi")
      // Drive the streamed onChunk callback.
      run.mock.calls[0][1].onChunk?.("partial", "stdout")
      await flush()
    })

    expect(dispatch).toHaveBeenCalledWith({ type: "BASH_START", command: "echo hi", id: "bash-1" })
    expect(dispatch).toHaveBeenCalledWith({ type: "BASH_APPEND", chunk: "partial", id: "bash-1" })
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "BASH_RESULT", status: "done", exitCode: 0, id: "bash-1" })
    )
    expect(run).toHaveBeenCalledWith("echo hi", expect.objectContaining({ cwd: "/repo" }))
  })

  it("captures a non-zero foreground failure for /analyze (taken once)", async () => {
    const dispatch = jest.fn()
    const { run } = makeRunShell({ code: 2, stdout: "", stderr: "boom", aborted: false })
    const { result } = renderHook(() => useBashShellout(run, "/repo", dispatch))

    await act(async () => {
      result.current.runBash("false")
      await flush()
    })

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "BASH_RESULT", status: "error", exitCode: 2 })
    )
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "NOTICE",
        message: expect.stringContaining("/analyze"),
      })
    )
    const failure = result.current.takeLastFailedBash()
    expect(failure).toMatchObject({ command: "false", exitCode: 2 })
    // A second take is empty.
    expect(result.current.takeLastFailedBash()).toBeNull()
  })

  it("does not capture an aborted run as a failure", async () => {
    const dispatch = jest.fn()
    const { run } = makeRunShell({ code: 130, stdout: "", stderr: "", aborted: true })
    const { result } = renderHook(() => useBashShellout(run, "/repo", dispatch))
    await act(async () => {
      result.current.runBash("sleep 10")
      await flush()
    })
    expect(result.current.takeLastFailedBash()).toBeNull()
  })

  it("reports a rejected runShell as an error result", async () => {
    const dispatch = jest.fn()
    const { run } = makeRunShell(new Error("spawn failed"))
    const { result } = renderHook(() => useBashShellout(run, "/repo", dispatch))
    await act(async () => {
      result.current.runBash("nope")
      await flush()
    })
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "BASH_RESULT", status: "error", output: "spawn failed" })
    )
  })

  it("tracks the foreground run and backgrounds the prior one on a new run", async () => {
    const dispatch = jest.fn()
    // Never-resolving run so it stays in the foreground.
    const run = jest.fn(() => new Promise<ShellResult>(() => {}))
    const { result } = renderHook(() => useBashShellout(run, "/repo", dispatch))

    expect(result.current.hasForegroundRun()).toBe(false)
    act(() => result.current.runBash("first"))
    expect(result.current.hasForegroundRun()).toBe(true)

    dispatch.mockClear()
    act(() => result.current.runBash("second"))
    // Starting "second" backgrounds "first".
    expect(dispatch).toHaveBeenCalledWith({ type: "BASH_BACKGROUND", id: "bash-1" })
    expect(dispatch).toHaveBeenCalledWith({ type: "BASH_START", command: "second", id: "bash-2" })
  })

  it("backgroundForegroundBash / killForegroundBash return false with no run", () => {
    const dispatch = jest.fn()
    const run = jest.fn(() => new Promise<ShellResult>(() => {}))
    const { result } = renderHook(() => useBashShellout(run, "/repo", dispatch))
    expect(result.current.backgroundForegroundBash()).toBe(false)
    expect(result.current.killForegroundBash()).toBe(false)
  })

  it("kills the foreground run, aborting its controller", () => {
    const dispatch = jest.fn()
    let captured: AbortSignal | undefined
    const run = jest.fn((_c: string, opts: RunShellOpts) => {
      captured = opts.signal
      return new Promise<ShellResult>(() => {})
    })
    const { result } = renderHook(() => useBashShellout(run, "/repo", dispatch))
    act(() => result.current.runBash("watch"))
    act(() => {
      expect(result.current.killForegroundBash()).toBe(true)
    })
    expect(captured?.aborted).toBe(true)
    expect(result.current.hasForegroundRun()).toBe(false)
    expect(dispatch).toHaveBeenCalledWith({ type: "NOTICE", message: "Command interrupted" })
  })

  it("backgrounds the foreground run on demand", () => {
    const dispatch = jest.fn()
    const run = jest.fn(() => new Promise<ShellResult>(() => {}))
    const { result } = renderHook(() => useBashShellout(run, "/repo", dispatch))
    act(() => result.current.runBash("dev"))
    act(() => {
      expect(result.current.backgroundForegroundBash()).toBe(true)
    })
    expect(result.current.hasForegroundRun()).toBe(false)
    expect(dispatch).toHaveBeenCalledWith({
      type: "NOTICE",
      message: "Command moved to background · /bashes to manage",
    })
  })

  it("keeps backgrounded runs in the registry so /bashes can list them", () => {
    const dispatch = jest.fn()
    const run = jest.fn(() => new Promise<ShellResult>(() => {}))
    const { result } = renderHook(() => useBashShellout(run, "/repo", dispatch))
    act(() => result.current.runBash("dev-server"))
    act(() => {
      result.current.backgroundForegroundBash()
    })
    act(() => result.current.runBash("watcher"))

    const runs = result.current.listBashRuns()
    expect(runs).toHaveLength(2)
    expect(runs[0]).toMatchObject({ id: "bash-1", command: "dev-server", background: true })
    expect(runs[1]).toMatchObject({ id: "bash-2", command: "watcher", background: false })
    expect(runs[0].startedAt).toBeGreaterThan(0)
  })

  it("killBash aborts a BACKGROUNDED run by id (the old leak)", () => {
    const dispatch = jest.fn()
    const signals: AbortSignal[] = []
    const run = jest.fn((_c: string, opts: RunShellOpts) => {
      if (opts.signal) signals.push(opts.signal)
      return new Promise<ShellResult>(() => {})
    })
    const { result } = renderHook(() => useBashShellout(run, "/repo", dispatch))
    act(() => result.current.runBash("dev-server"))
    act(() => {
      result.current.backgroundForegroundBash()
    })

    act(() => {
      expect(result.current.killBash("bash-1")).toBe(true)
    })
    expect(signals[0].aborted).toBe(true)
    expect(dispatch).toHaveBeenCalledWith({ type: "NOTICE", message: "Killed: dev-server" })
    // Unknown / already-killed ids are a miss.
    expect(result.current.killBash("bash-1")).toBe(true) // still live until it settles
    expect(result.current.killBash("nope")).toBe(false)
  })

  it("foregroundBash swaps the Ctrl+C target and demotes the prior foreground", () => {
    const dispatch = jest.fn()
    const run = jest.fn(() => new Promise<ShellResult>(() => {}))
    const { result } = renderHook(() => useBashShellout(run, "/repo", dispatch))
    act(() => result.current.runBash("first"))
    act(() => result.current.runBash("second")) // backgrounds "first"

    dispatch.mockClear()
    act(() => {
      expect(result.current.foregroundBash("bash-1")).toBe(true)
    })
    // "second" was the foreground — it gets demoted; "first" is promoted.
    expect(dispatch).toHaveBeenCalledWith({ type: "BASH_BACKGROUND", id: "bash-2" })
    expect(dispatch).toHaveBeenCalledWith({ type: "BASH_FOREGROUND", id: "bash-1" })
    expect(result.current.listBashRuns()).toEqual([
      expect.objectContaining({ id: "bash-1", background: false }),
      expect.objectContaining({ id: "bash-2", background: true }),
    ])
    expect(result.current.hasForegroundRun()).toBe(true)
    // Ctrl+C now kills "first".
    act(() => {
      expect(result.current.killForegroundBash()).toBe(true)
    })
    expect(result.current.hasForegroundRun()).toBe(false)
    expect(result.current.foregroundBash("nope")).toBe(false)
  })

  it("removes a settled run from the registry", async () => {
    const dispatch = jest.fn()
    const { run } = makeRunShell(ok)
    const { result } = renderHook(() => useBashShellout(run, "/repo", dispatch))
    await act(async () => {
      result.current.runBash("echo hi")
      await flush()
    })
    expect(result.current.listBashRuns()).toEqual([])
    expect(result.current.hasForegroundRun()).toBe(false)
  })

  it("sendInputToForeground returns false with no foreground run", () => {
    const dispatch = jest.fn()
    const run = jest.fn(() => new Promise<ShellResult>(() => {}))
    const { result } = renderHook(() => useBashShellout(run, "/repo", dispatch))
    expect(result.current.sendInputToForeground("yes")).toBe(false)
  })

  it("sendInputToForeground writes a newline-terminated line to the foreground stdin", () => {
    const dispatch = jest.fn()
    const writes: string[] = []
    const run = jest.fn((_c: string, opts: RunShellOpts) => {
      opts.registerInput?.((d) => writes.push(d))
      return new Promise<ShellResult>(() => {})
    })
    const { result } = renderHook(() => useBashShellout(run, "/repo", dispatch))
    act(() => result.current.runBash("ssh host"))
    act(() => {
      expect(result.current.sendInputToForeground("yes")).toBe(true)
    })
    expect(writes).toEqual(["yes\n"])
    // An already-terminated line is not double-terminated.
    act(() => {
      result.current.sendInputToForeground("no\n")
    })
    expect(writes).toEqual(["yes\n", "no\n"])
  })

  it("sendInputToForeground returns false before the run exposes a stdin writer", () => {
    const dispatch = jest.fn()
    // A run that never calls registerInput (no stdin surface yet).
    const run = jest.fn(() => new Promise<ShellResult>(() => {}))
    const { result } = renderHook(() => useBashShellout(run, "/repo", dispatch))
    act(() => result.current.runBash("first"))
    expect(result.current.sendInputToForeground("hi")).toBe(false)
  })

  it("notifies when a foreground command is interactive", () => {
    const dispatch = jest.fn()
    const run = jest.fn(() => new Promise<ShellResult>(() => {}))
    const { result } = renderHook(() => useBashShellout(run, "/repo", dispatch))
    act(() => result.current.runBash("ssh example.com"))
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "NOTICE",
        message: expect.stringContaining("Interactive command"),
      })
    )
  })

  it("does not post the interactive notice for a normal command", () => {
    const dispatch = jest.fn()
    const run = jest.fn(() => new Promise<ShellResult>(() => {}))
    const { result } = renderHook(() => useBashShellout(run, "/repo", dispatch))
    act(() => result.current.runBash("echo hi"))
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Interactive command") })
    )
  })
})
