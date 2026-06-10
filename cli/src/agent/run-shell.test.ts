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

  it("runs a real command via the default shell spawn", async () => {
    const r = await runShell("node -e \"process.stdout.write('ok')\"")
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("ok")
  }, 15000)
})
