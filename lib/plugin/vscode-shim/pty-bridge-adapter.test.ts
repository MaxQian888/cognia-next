/**
 * @jest-environment jsdom
 */

import { createPtyShellSpawn, type TerminalSessionSpawner } from "./pty-bridge-adapter"

interface FakeLiveSession {
  writes: Uint8Array[]
  killed: boolean
  dataListeners: Array<(b: Uint8Array) => void>
  exitListeners: Array<(code: number | null) => void>
  write: (bytes: Uint8Array) => Promise<void>
  kill: () => Promise<void>
  onData: (l: (b: Uint8Array) => void) => () => void
  onExit: (l: (c: number | null) => void) => () => void
}

function makeFakeLiveSession(): FakeLiveSession {
  const writes: Uint8Array[] = []
  const dataListeners: Array<(b: Uint8Array) => void> = []
  const exitListeners: Array<(c: number | null) => void> = []
  return {
    writes,
    killed: false,
    dataListeners,
    exitListeners,
    write: async (b) => {
      writes.push(b)
    },
    kill: async () => {
      // Closure capture pattern — set the flag in the outer scope so the
      // test can assert against it.
    },
    onData: (l) => {
      dataListeners.push(l)
      return () => {
        const i = dataListeners.indexOf(l)
        if (i >= 0) dataListeners.splice(i, 1)
      }
    },
    onExit: (l) => {
      exitListeners.push(l)
      return () => {
        const i = exitListeners.indexOf(l)
        if (i >= 0) exitListeners.splice(i, 1)
      }
    },
  }
}

function deferredSpawner(): {
  spawner: TerminalSessionSpawner
  resolve: (s: FakeLiveSession) => void
  reject: (e: Error) => void
} {
  let resolveFn: ((s: FakeLiveSession) => void) | null = null
  let rejectFn: ((e: Error) => void) | null = null
  const spawner: TerminalSessionSpawner = () =>
    new Promise((res, rej) => {
      resolveFn = res
      rejectFn = rej
    })
  return {
    spawner,
    resolve: (s) => resolveFn?.(s),
    reject: (e) => rejectFn?.(e),
  }
}

describe("createPtyShellSpawn", () => {
  it("returns a ShellChildProcess shape compatible with the bridge contract", () => {
    const spawner: TerminalSessionSpawner = async () => makeFakeLiveSession()
    const spawn = createPtyShellSpawn({ spawner })
    const child = spawn("/bin/sh", ["-l"], { cwd: "/tmp" })
    expect(child).toMatchObject({
      pid: 0,
      finished: expect.any(Promise),
      write: expect.any(Function),
      kill: expect.any(Function),
      onStdout: expect.any(Function),
      onStderr: expect.any(Function),
    })
  })

  it("passes shell + args + cwd + env to the underlying spawner", async () => {
    const captured: unknown[] = []
    const spawner: TerminalSessionSpawner = async (req) => {
      captured.push(req)
      return makeFakeLiveSession()
    }
    const spawn = createPtyShellSpawn({ spawner })
    spawn("/bin/bash", ["-c", "echo hi"], { cwd: "/tmp", env: { FOO: "bar" } })
    await new Promise((r) => setTimeout(r, 0))
    expect(captured[0]).toMatchObject({
      shell: "/bin/bash",
      args: ["-c", "echo hi"],
      cwd: "/tmp",
      env: { FOO: "bar" },
      enableShellIntegration: false,
    })
  })

  it("forwards data events as utf-8 strings to stdout listeners", async () => {
    const session = makeFakeLiveSession()
    const spawner: TerminalSessionSpawner = async () => session
    const spawn = createPtyShellSpawn({ spawner })
    const child = spawn("/bin/sh", [], {})
    const stdoutSeen: string[] = []
    child.onStdout((c) => stdoutSeen.push(c))
    await new Promise((r) => setTimeout(r, 0))
    session.dataListeners[0]?.(new Uint8Array([104, 105])) // "hi"
    expect(stdoutSeen).toEqual(["hi"])
  })

  it("never fires stderr listeners (PTYs merge streams)", async () => {
    const session = makeFakeLiveSession()
    const spawner: TerminalSessionSpawner = async () => session
    const spawn = createPtyShellSpawn({ spawner })
    const child = spawn("/bin/sh", [], {})
    const stderrSeen: string[] = []
    child.onStderr((c) => stderrSeen.push(c))
    await new Promise((r) => setTimeout(r, 0))
    session.dataListeners[0]?.(new Uint8Array([1, 2, 3]))
    expect(stderrSeen).toEqual([])
  })

  it("resolves `finished` with the exit code when the session exits", async () => {
    const session = makeFakeLiveSession()
    const spawner: TerminalSessionSpawner = async () => session
    const spawn = createPtyShellSpawn({ spawner })
    const child = spawn("/bin/sh", [], {})
    await new Promise((r) => setTimeout(r, 0))
    session.exitListeners[0]?.(42)
    const result = await child.finished
    expect(result).toEqual({ exitCode: 42, signal: null })
  })

  it("resolves `finished` with null exitCode when spawn rejects", async () => {
    const { spawner, reject } = deferredSpawner()
    const spawn = createPtyShellSpawn({ spawner })
    const consoleWarn = jest.spyOn(console, "warn").mockImplementation(() => {})
    const child = spawn("/missing", [], {})
    reject(new Error("ENOENT"))
    const result = await child.finished
    expect(result).toEqual({ exitCode: null, signal: null })
    expect(consoleWarn).toHaveBeenCalled()
    consoleWarn.mockRestore()
  })

  it("queues writes issued before the session lands and replays them", async () => {
    const { spawner, resolve } = deferredSpawner()
    const session = makeFakeLiveSession()
    const spawn = createPtyShellSpawn({ spawner })
    const child = spawn("/bin/sh", [], {})
    child.write("first")
    child.write("second")
    expect(session.writes).toHaveLength(0)
    resolve(session)
    await new Promise((r) => setTimeout(r, 0))
    expect(session.writes.map((b) => new TextDecoder().decode(b))).toEqual(["first", "second"])
  })

  it("queued kill replays after spawn lands", async () => {
    const { spawner, resolve } = deferredSpawner()
    const killSpy = jest.fn(async () => {})
    const session = makeFakeLiveSession()
    session.kill = killSpy
    const spawn = createPtyShellSpawn({ spawner })
    const child = spawn("/bin/sh", [], {})
    child.kill()
    expect(killSpy).not.toHaveBeenCalled()
    resolve(session)
    await new Promise((r) => setTimeout(r, 0))
    expect(killSpy).toHaveBeenCalled()
  })

  it("kill after the session is live forwards to session.kill immediately", async () => {
    const session = makeFakeLiveSession()
    const killSpy = jest.fn(async () => {})
    session.kill = killSpy
    const spawner: TerminalSessionSpawner = async () => session
    const spawn = createPtyShellSpawn({ spawner })
    const child = spawn("/bin/sh", [], {})
    await new Promise((r) => setTimeout(r, 0))
    child.kill()
    expect(killSpy).toHaveBeenCalled()
  })

  it("swallows listener exceptions during dispatch", async () => {
    const session = makeFakeLiveSession()
    const spawner: TerminalSessionSpawner = async () => session
    const spawn = createPtyShellSpawn({ spawner })
    const child = spawn("/bin/sh", [], {})
    const seen: string[] = []
    child.onStdout(() => {
      throw new Error("boom")
    })
    child.onStdout((c) => seen.push(c))
    await new Promise((r) => setTimeout(r, 0))
    const consoleWarn = jest.spyOn(console, "warn").mockImplementation(() => {})
    session.dataListeners[0]?.(new Uint8Array([65]))
    expect(seen).toEqual(["A"])
    consoleWarn.mockRestore()
  })

  it("populates extensionId from the resolver when provided", async () => {
    const captured: unknown[] = []
    const spawner: TerminalSessionSpawner = async (req) => {
      captured.push(req)
      return makeFakeLiveSession()
    }
    const spawn = createPtyShellSpawn({
      spawner,
      extensionIdResolver: () => "ext.foo",
    })
    spawn("/bin/sh", [], {})
    await new Promise((r) => setTimeout(r, 0))
    expect(captured[0]).toMatchObject({ extensionId: "ext.foo" })
  })

  it("unsubscribe returned from onStdout removes the listener", async () => {
    const session = makeFakeLiveSession()
    const spawner: TerminalSessionSpawner = async () => session
    const spawn = createPtyShellSpawn({ spawner })
    const child = spawn("/bin/sh", [], {})
    const seen: string[] = []
    const off = child.onStdout((c) => seen.push(c))
    await new Promise((r) => setTimeout(r, 0))
    session.dataListeners[0]?.(new Uint8Array([65]))
    off()
    session.dataListeners[0]?.(new Uint8Array([66]))
    expect(seen).toEqual(["A"])
  })
})
