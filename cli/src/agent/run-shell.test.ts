/**
 * @jest-environment node
 */
import { runShell, type ShellChild, type ShellSpawn } from "./run-shell"

function fakeChild(opts: {
  out?: string[]
  err?: string[]
  code?: number
  error?: Error
}): ShellChild {
  const handlers: Record<string, ((arg: unknown) => void)[]> = {}
  const child: ShellChild = {
    stdout: {
      on: (_e, cb) => {
        for (const d of opts.out ?? []) cb(d)
      },
    },
    stderr: {
      on: (_e, cb) => {
        for (const d of opts.err ?? []) cb(d)
      },
    },
    on(event, cb) {
      ;(handlers[event] ??= []).push(cb as (arg: unknown) => void)
    },
  }
  // Fire terminal event after registration on next tick.
  queueMicrotask(() => {
    if (opts.error) handlers.error?.forEach((cb) => cb(opts.error))
    else handlers.close?.forEach((cb) => cb(opts.code ?? 0))
  })
  return child
}

describe("runShell", () => {
  it("collects stdout/stderr and resolves with the exit code", async () => {
    const spawn: ShellSpawn = () => fakeChild({ out: ["hello "], err: ["w"], code: 0 })
    expect(await runShell("echo hi", { spawn })).toEqual({ stdout: "hello ", stderr: "w", code: 0 })
  })

  it("reports a non-zero exit code", async () => {
    const spawn: ShellSpawn = () => fakeChild({ out: [], code: 3 })
    expect((await runShell("false", { spawn })).code).toBe(3)
  })

  it("resolves with code 1 when the process errors", async () => {
    const spawn: ShellSpawn = () => fakeChild({ error: new Error("ENOENT") })
    const r = await runShell("nope", { spawn })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("ENOENT")
  })

  it("resolves with code 1 when spawn throws synchronously", async () => {
    const spawn: ShellSpawn = () => {
      throw new Error("spawn failed")
    }
    const r = await runShell("x", { spawn })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("spawn failed")
  })

  it("streams each chunk via onChunk as the process writes, tagged by stream", async () => {
    const spawn: ShellSpawn = () => fakeChild({ out: ["a", "b"], err: ["e"], code: 0 })
    const chunks: Array<[string, string]> = []
    const r = await runShell("x", { spawn, onChunk: (text, stream) => chunks.push([text, stream]) })
    expect(chunks).toEqual([
      ["a", "stdout"],
      ["b", "stdout"],
      ["e", "stderr"],
    ])
    // The resolved result still carries the full accumulated text.
    expect(r).toEqual({ stdout: "ab", stderr: "e", code: 0 })
  })

  it("runs a real command via the default shell spawn", async () => {
    const r = await runShell("node -e \"process.stdout.write('ok')\"")
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("ok")
  }, 15000)

  it("kills the child and resolves aborted when the signal fires", async () => {
    // A long-running fake child that only closes once killed, so we can drive
    // the abort path deterministically.
    const handlers: Record<string, ((arg: unknown) => void)[]> = {}
    const kill = jest.fn((_signal?: unknown) => {
      handlers.close?.forEach((cb) => cb(null))
    })
    const child: ShellChild = {
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on(event, cb) {
        ;(handlers[event] ??= []).push(cb as (arg: unknown) => void)
      },
      kill,
    }
    const controller = new AbortController()
    const promise = runShell("sleep 100", { spawn: () => child, signal: controller.signal })
    controller.abort()
    const r = await promise
    expect(kill).toHaveBeenCalledWith("SIGTERM")
    expect(r.aborted).toBe(true)
    expect(r.code).toBe(130)
  })

  it("resolves aborted immediately when the signal is already aborted", async () => {
    const handlers: Record<string, ((arg: unknown) => void)[]> = {}
    const kill = jest.fn(() => handlers.close?.forEach((cb) => cb(null)))
    const child: ShellChild = {
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on(event, cb) {
        ;(handlers[event] ??= []).push(cb as (arg: unknown) => void)
      },
      kill,
    }
    const r = await runShell("x", { spawn: () => child, signal: AbortSignal.abort() })
    expect(kill).toHaveBeenCalled()
    expect(r.aborted).toBe(true)
  })
})
