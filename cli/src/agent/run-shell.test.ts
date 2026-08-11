/**
 * @jest-environment node
 */
import {
  runInteractiveShell,
  runShell,
  type InteractiveShellChild,
  type InteractiveShellSpawn,
  type ShellChild,
  type ShellSpawn,
} from "./run-shell"

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

  it("hands registerInput a writer that appends to the child's stdin", async () => {
    const handlers: Record<string, ((arg: unknown) => void)[]> = {}
    const writes: string[] = []
    const child: ShellChild = {
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      stdin: { write: (d) => writes.push(d) },
      on(event, cb) {
        ;(handlers[event] ??= []).push(cb as (arg: unknown) => void)
      },
    }
    let writer: ((d: string) => void) | undefined
    const promise = runShell("cat", {
      spawn: () => child,
      registerInput: (w) => {
        writer = w
      },
    })
    // registerInput fires synchronously during the spawn, before runShell resolves.
    expect(writer).toBeDefined()
    writer!("yes\n")
    expect(writes).toEqual(["yes\n"])
    handlers.close?.forEach((cb) => cb(0))
    await promise
  })

  it("drops stdin writes after the run is aborted", async () => {
    const handlers: Record<string, ((arg: unknown) => void)[]> = {}
    const writes: string[] = []
    const kill = jest.fn(() => handlers.close?.forEach((cb) => cb(null)))
    const child: ShellChild = {
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      stdin: { write: (d) => writes.push(d) },
      on(event, cb) {
        ;(handlers[event] ??= []).push(cb as (arg: unknown) => void)
      },
      kill,
    }
    let writer: ((d: string) => void) | undefined
    const controller = new AbortController()
    const promise = runShell("cat", {
      spawn: () => child,
      signal: controller.signal,
      registerInput: (w) => {
        writer = w
      },
    })
    writer!("before\n")
    controller.abort()
    const r = await promise
    writer!("after\n")
    expect(writes).toEqual(["before\n"])
    expect(r.aborted).toBe(true)
  })

  it("does not call registerInput when the child has no stdin", async () => {
    const register = jest.fn()
    const spawn: ShellSpawn = () => fakeChild({ code: 0 })
    await runShell("x", { spawn, registerInput: register })
    expect(register).not.toHaveBeenCalled()
  })

  it("swallows errors when the child stdin write throws (EPIPE)", async () => {
    const handlers: Record<string, ((arg: unknown) => void)[]> = {}
    const child: ShellChild = {
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      stdin: {
        write: () => {
          throw new Error("EPIPE")
        },
      },
      on(event, cb) {
        ;(handlers[event] ??= []).push(cb as (arg: unknown) => void)
      },
    }
    let writer: ((d: string) => void) | undefined
    const promise = runShell("cat", {
      spawn: () => child,
      registerInput: (w) => {
        writer = w
      },
    })
    expect(() => writer!("x\n")).not.toThrow()
    handlers.close?.forEach((cb) => cb(0))
    await promise
  })
})

describe("runInteractiveShell", () => {
  it("attaches the child to inherited terminal I/O", async () => {
    const handlers: Record<string, ((...args: unknown[]) => void)[]> = {}
    const spawn: InteractiveShellSpawn = jest.fn((_command, opts) => {
      expect(opts).toEqual({ cwd: "/repo", shell: true, stdio: "inherit" })
      const child: InteractiveShellChild = {
        on(event, cb) {
          ;(handlers[event] ??= []).push(cb as (...args: unknown[]) => void)
        },
      }
      queueMicrotask(() => handlers.close?.forEach((cb) => cb(0, null)))
      return child
    })

    await expect(runInteractiveShell("top", { cwd: "/repo", spawn })).resolves.toEqual({
      stdout: "",
      stderr: "",
      code: 0,
    })
    expect(spawn).toHaveBeenCalledWith("top", {
      cwd: "/repo",
      shell: true,
      stdio: "inherit",
    })
  })

  it("interrupts an externally aborted interactive child", async () => {
    const handlers: Record<string, ((...args: unknown[]) => void)[]> = {}
    const kill = jest.fn(() => handlers.close?.forEach((cb) => cb(null, "SIGINT")))
    const child: InteractiveShellChild = {
      on(event, cb) {
        ;(handlers[event] ??= []).push(cb as (...args: unknown[]) => void)
      },
      kill,
    }
    const controller = new AbortController()
    const promise = runInteractiveShell("top", { spawn: () => child, signal: controller.signal })

    controller.abort()

    await expect(promise).resolves.toMatchObject({ code: 130, aborted: true })
    expect(kill).toHaveBeenCalledWith("SIGINT")
  })

  it("honors a signal that was aborted before the interactive spawn", async () => {
    const handlers: Record<string, ((...args: unknown[]) => void)[]> = {}
    const kill = jest.fn(() => handlers.close?.forEach((cb) => cb(null, "SIGINT")))
    const child: InteractiveShellChild = {
      on(event, cb) {
        ;(handlers[event] ??= []).push(cb as (...args: unknown[]) => void)
      },
      kill,
    }

    await expect(
      runInteractiveShell("top", { spawn: () => child, signal: AbortSignal.abort() })
    ).resolves.toMatchObject({ code: 130, aborted: true })
    expect(kill).toHaveBeenCalledWith("SIGINT")
  })

  it("reports interactive spawn failures", async () => {
    const result = await runInteractiveShell("top", {
      spawn: () => {
        throw new Error("spawn failed")
      },
    })
    expect(result).toEqual({ stdout: "", stderr: "spawn failed", code: 1 })
  })

  it("reports an asynchronous interactive child error only once", async () => {
    const handlers: Record<string, ((...args: unknown[]) => void)[]> = {}
    const child: InteractiveShellChild = {
      on(event, cb) {
        ;(handlers[event] ??= []).push(cb as (...args: unknown[]) => void)
      },
    }
    const promise = runInteractiveShell("top", { spawn: () => child })

    handlers.error?.forEach((cb) => cb(new Error("pty failed")))
    handlers.close?.forEach((cb) => cb(0, null))

    await expect(promise).resolves.toEqual({ stdout: "", stderr: "pty failed", code: 1 })
  })

  it("maps an unexplained null exit code to failure", async () => {
    const handlers: Record<string, ((...args: unknown[]) => void)[]> = {}
    const child: InteractiveShellChild = {
      on(event, cb) {
        ;(handlers[event] ??= []).push(cb as (...args: unknown[]) => void)
      },
    }
    const promise = runInteractiveShell("top", { spawn: () => child })

    handlers.close?.forEach((cb) => cb(null, null))

    await expect(promise).resolves.toEqual({ stdout: "", stderr: "", code: 1 })
  })

  it("still settles an aborted run when signaling the child throws", async () => {
    const handlers: Record<string, ((...args: unknown[]) => void)[]> = {}
    const child: InteractiveShellChild = {
      on(event, cb) {
        ;(handlers[event] ??= []).push(cb as (...args: unknown[]) => void)
      },
      kill() {
        throw new Error("already exited")
      },
    }
    const controller = new AbortController()
    const promise = runInteractiveShell("top", { spawn: () => child, signal: controller.signal })

    controller.abort()
    handlers.close?.forEach((cb) => cb(null, "SIGINT"))

    await expect(promise).resolves.toEqual({
      stdout: "",
      stderr: "",
      code: 130,
      aborted: true,
    })
  })
})
