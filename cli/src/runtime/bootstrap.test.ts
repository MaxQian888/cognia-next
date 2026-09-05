/**
 * @jest-environment node
 */
import { PassThrough } from "node:stream"
import { spawn as nodeSpawn } from "node:child_process"

jest.mock("node:child_process", () => ({ spawn: jest.fn() }))
import path from "node:path"

import { transport as installedTransport } from "@/lib/tauri"

import {
  adaptBunSubprocess,
  bootstrapSidecar,
  isPackaged,
  resolveBunSpawn,
  resolveSidecarScript,
  resolveSpawnTarget,
  type SpawnFn,
} from "./bootstrap"
import { StdioTransport } from "./stdio-transport"

function fakeChild(opts: { failWrite?: boolean } = {}) {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const writes: string[] = []
  let exitCb: ((code: number | null) => void) | null = null
  let errorCb: ((err: Error) => void) | null = null
  let stdinErrorCb: ((err: Error) => void) | null = null
  const kill = jest.fn()
  const child = {
    stdin: {
      write: (c: string) => {
        if (opts.failWrite) throw new Error("EPIPE")
        writes.push(c)
      },
      on: (_e: "error", cb: (err: Error) => void) => {
        stdinErrorCb = cb
      },
    },
    stdout,
    stderr,
    on: (e: "exit" | "error", cb: (arg: never) => void) => {
      if (e === "error") errorCb = cb as (err: Error) => void
      else exitCb = cb as (code: number | null) => void
      return child
    },
    kill,
  }
  return {
    child,
    stdout,
    stderr,
    writes,
    kill,
    exit: (c = 0) => exitCb?.(c),
    emitError: (err = new Error("boom")) => errorCb?.(err),
    emitStdinError: (err = new Error("EPIPE")) => stdinErrorCb?.(err),
  }
}

describe("resolveSidecarScript", () => {
  it("prefers $COGNIA_SIDECAR_SCRIPT", () => {
    expect(resolveSidecarScript({ COGNIA_SIDECAR_SCRIPT: "/x/claude-host.mjs" })).toBe(
      "/x/claude-host.mjs"
    )
  })

  it("locates the in-repo sidecar by walking up", () => {
    const resolved = resolveSidecarScript({})
    expect(resolved).toMatch(/claude-host\.mjs$/)
  })

  it("prefers a sidecar/ dir next to the executable (binary dist layout)", () => {
    const resolved = resolveSidecarScript(
      {},
      {
        execPath: "/opt/cognia/cognia-agent",
        exists: (p) => p === path.join("/opt/cognia", "sidecar", "claude-host.mjs"),
      }
    )
    expect(resolved).toBe(path.join("/opt/cognia", "sidecar", "claude-host.mjs"))
  })

  it("override beats the execPath-adjacent candidate", () => {
    const resolved = resolveSidecarScript(
      { COGNIA_SIDECAR_SCRIPT: "/x/claude-host.mjs" },
      { execPath: "/opt/cognia/cognia-agent", exists: () => true }
    )
    expect(resolved).toBe("/x/claude-host.mjs")
  })
})

describe("resolveSpawnTarget", () => {
  it("recognizes Bun standalone executables as packaged runtimes", () => {
    expect(isPackaged({ pkg: undefined, bunStandalone: true })).toBe(true)
    expect(isPackaged({ pkg: undefined, bunStandalone: false })).toBe(false)
  })

  it("keeps recognizing legacy pkg executables during the transition", () => {
    expect(isPackaged({ pkg: {}, bunStandalone: false })).toBe(true)
  })

  it("self-execs the binary with COGNIA_ROLE=sidecar when packaged", () => {
    const t = resolveSpawnTarget("/dist/sidecar/claude-host.mjs", { PATH: "/usr/bin" }, true)
    expect(t.command).toBe(process.execPath)
    expect(t.args).toEqual([])
    expect(t.env).toMatchObject({
      PATH: "/usr/bin",
      COGNIA_ROLE: "sidecar",
      COGNIA_SIDECAR_SCRIPT: "/dist/sidecar/claude-host.mjs",
    })
  })

  it("runs `node <script>` in dev (not packaged)", () => {
    const baseEnv = { PATH: "/usr/bin" }
    const t = resolveSpawnTarget("/repo/sidecar/claude-host.mjs", baseEnv, false)
    expect(t.command).toBe("node")
    expect(t.args).toEqual(["/repo/sidecar/claude-host.mjs"])
    expect(t.env).toBe(baseEnv)
    expect(t.env).not.toHaveProperty("COGNIA_ROLE")
  })
})

describe("resolveBunSpawn", () => {
  it("selects only a callable Bun spawn capability", () => {
    const spawn = jest.fn(() => ({ native: true }))
    const resolved = resolveBunSpawn({ spawn: spawn as never })

    expect(
      resolved?.(["command"], {
        cwd: "/workspace",
        env: {},
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })
    ).toEqual({ native: true })
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(resolveBunSpawn({ spawn: "not-callable" as never })).toBeUndefined()
    expect(resolveBunSpawn(undefined)).toBeUndefined()
  })
})

describe("adaptBunSubprocess", () => {
  it("keeps Bun's native stdin pipe writable and flushes every protocol frame", async () => {
    const write = jest.fn()
    const flush = jest.fn()
    const end = jest.fn()
    const kill = jest.fn()
    const unref = jest.fn()
    let resolveExit!: (code: number) => void
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve
    })
    const child = adaptBunSubprocess({
      stdin: { write, flush, end },
      stdout: new ReadableStream<Uint8Array>(),
      exited,
      kill,
      unref,
    })
    const onExit = jest.fn()
    child.on("exit", onExit)

    child.stdin?.write('{"type":"send"}\n')
    expect(write).toHaveBeenCalledWith('{"type":"send"}\n')
    expect(flush).toHaveBeenCalledTimes(1)
    expect(onExit).not.toHaveBeenCalled()

    resolveExit(0)
    await exited
    await Promise.resolve()
    expect(onExit).toHaveBeenCalledWith(0)
    child.kill()
    expect(end).toHaveBeenCalledTimes(1)
    expect(kill).toHaveBeenCalled()
    expect(unref).toHaveBeenCalled()
  })
})

describe("bootstrapSidecar", () => {
  it("does not require an adjacent sidecar script in a standalone executable", async () => {
    const f = fakeChild()
    let spawnedScript = ""
    const spawn: SpawnFn = (script) => {
      spawnedScript = script
      setImmediate(() => f.stdout.write(JSON.stringify({ type: "ready" }) + "\n"))
      return f.child
    }
    const boot = await bootstrapSidecar({
      spawn,
      packaged: true,
      execPath: "/dist/cognia-agent",
      cwd: "/workspace",
    })
    expect(spawnedScript).toBe("/dist/cognia-agent")
    await boot.shutdown()
  })

  it("installs the StdioTransport process-wide and resolves on ready", async () => {
    const f = fakeChild()
    const spawn: SpawnFn = () => {
      // Emit `ready` on the next tick, after the transport has subscribed.
      setImmediate(() => f.stdout.write(JSON.stringify({ type: "ready" }) + "\n"))
      return f.child
    }
    const boot = await bootstrapSidecar({ spawn, scriptPath: "/x/claude-host.mjs" })
    expect(boot.transport).toBeInstanceOf(StdioTransport)
    expect(installedTransport).toBe(boot.transport) // setTransport swapped the live binding
    expect(boot.transport.isReady()).toBe(true)
  })

  it("forwards a send through the installed transport to the child's stdin", async () => {
    const f = fakeChild()
    const spawn: SpawnFn = () => {
      setImmediate(() => f.stdout.write(JSON.stringify({ type: "ready" }) + "\n"))
      return f.child
    }
    const boot = await bootstrapSidecar({ spawn, scriptPath: "/x/claude-host.mjs" })
    await boot.transport.call("claude_send", { sessionId: "s1", prompt: "hi" })
    expect(JSON.parse(f.writes[0].trim())).toMatchObject({ type: "send", sessionId: "s1" })
  })

  it("kills the child and rejects when ready never arrives", async () => {
    const f = fakeChild()
    const spawn: SpawnFn = () => f.child // never emits ready
    await expect(
      bootstrapSidecar({ spawn, scriptPath: "/x/claude-host.mjs", readyTimeoutMs: 20 })
    ).rejects.toThrow(/did not become ready/)
    expect(f.kill).toHaveBeenCalled()
  })

  it("tears down (not crash) when the child emits an 'error' event", async () => {
    const f = fakeChild()
    const spawn: SpawnFn = () => {
      setImmediate(() => f.stdout.write(JSON.stringify({ type: "ready" }) + "\n"))
      return f.child
    }
    const boot = await bootstrapSidecar({ spawn, scriptPath: "/x/claude-host.mjs" })
    f.emitError(new Error("ENOENT")) // would be an unhandled crash without the handler
    await expect(
      boot.transport.call("claude_send", { sessionId: "s", prompt: "x" })
    ).rejects.toThrow(/sidecar not running/)
  })

  it("tears down when the child stdin emits an 'error' event", async () => {
    const f = fakeChild()
    const spawn: SpawnFn = () => {
      setImmediate(() => f.stdout.write(JSON.stringify({ type: "ready" }) + "\n"))
      return f.child
    }
    const boot = await bootstrapSidecar({ spawn, scriptPath: "/x/claude-host.mjs" })
    f.emitStdinError() // async EPIPE on the pipe
    await expect(
      boot.transport.call("claude_send", { sessionId: "s", prompt: "x" })
    ).rejects.toThrow(/sidecar not running/)
  })

  it("tears down when a stdin write throws synchronously (broken pipe)", async () => {
    const f = fakeChild({ failWrite: true })
    const spawn: SpawnFn = () => {
      setImmediate(() => f.stdout.write(JSON.stringify({ type: "ready" }) + "\n"))
      return f.child
    }
    const boot = await bootstrapSidecar({ spawn, scriptPath: "/x/claude-host.mjs" })
    // First send: the write throws EPIPE, is caught in toHandle, and triggers teardown.
    await boot.transport.call("claude_send", { sessionId: "s", prompt: "x" })
    await expect(
      boot.transport.call("claude_send", { sessionId: "s", prompt: "y" })
    ).rejects.toThrow(/sidecar not running/)
  })

  it("shutdown kills the child once", async () => {
    const f = fakeChild()
    const spawn: SpawnFn = () => {
      setImmediate(() => f.stdout.write(JSON.stringify({ type: "ready" }) + "\n"))
      return f.child
    }
    const boot = await bootstrapSidecar({ spawn, scriptPath: "/x/claude-host.mjs" })
    await boot.shutdown()
    await boot.shutdown() // idempotent
    expect(f.kill).toHaveBeenCalledTimes(1)
  })
})

describe("bootstrap startup diagnostics", () => {
  it("surfaces a redacted module-load cause when stderr precedes a before-ready exit", async () => {
    const f = fakeChild()
    const boot = bootstrapSidecar({
      scriptPath: "/dist/claude-host.mjs",
      spawn: () => f.child,
      env: { NODE_ENV: "test", API_KEY: "opaque-test-credential" },
    })
    f.stderr.write("Error: Cannot find module '@babel/traverse'\ncode: MODULE_NOT_FOUND\n")
    f.stderr.write("Authorization: Bear")
    f.stderr.write("er fake-bearer-value\nAPI_KEY=another-secret\nopaque-test-")
    f.stderr.end("credential\n")
    f.exit(1)
    const error = await boot.catch((err: Error) => err)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("sidecar exited before ready")
    expect((error as Error).message).toContain("@babel/traverse")
    expect((error as Error).message).toContain("MODULE_NOT_FOUND")
    expect((error as Error).message).not.toMatch(
      /fake-bearer-value|another-secret|opaque-test-credential/
    )
    expect((error as Error).message).toContain("[REDACTED]")
    expect(f.kill).toHaveBeenCalledTimes(1)
  })

  it("drains chatty stderr after ready without changing stdout protocol or stdin writes", async () => {
    const f = fakeChild()
    const booting = bootstrapSidecar({ scriptPath: "/x/host.mjs", spawn: () => f.child })
    f.stdout.write('{"type":"ready"}\n')
    const boot = await booting
    for (let i = 0; i < 128; i++) f.stderr.write(Buffer.alloc(16_384, 120))
    expect(f.stderr.readableLength).toBe(0)
    expect(f.stderr.writableLength).toBe(0)
    await boot.transport.call("claude_send", { sessionId: "s", prompt: "still works" })
    expect(JSON.parse(f.writes[0])).toMatchObject({ type: "send", prompt: "still works" })
    await boot.shutdown()
  })
})

it("bounds startup noise and drops oversized credential lines while retaining the final cause", async () => {
  const f = fakeChild()
  const boot = bootstrapSidecar({
    scriptPath: "/x/host.mjs",
    spawn: () => f.child,
    env: { NODE_ENV: "test" },
  })
  for (let i = 0; i < 100; i++) f.stderr.write(`noise-${i} ${"x".repeat(200)}\n`)
  f.stderr.write("API_KEY=" + "credential".repeat(1000))
  f.stderr.write("continued-secret\n")
  f.stderr.end("Error: Cannot find module '@babel/traverse' [MODULE_NOT_FOUND]")
  f.exit(1)
  const error = (await boot.catch((err: Error) => err)) as Error
  expect(error.message.length).toBeLessThan(8500)
  expect(error.message).not.toContain("noise-0 ")
  expect(error.message).not.toContain("credential")
  expect(error.message).not.toContain("continued-secret")
  expect(error.message).toContain("[oversized stderr line omitted]")
  expect(error.message).toContain("@babel/traverse")
})

it("waits briefly for stderr that closes after exit and decodes split UTF-8", async () => {
  const f = fakeChild()
  const boot = bootstrapSidecar({
    scriptPath: "/x/host.mjs",
    spawn: () => f.child,
    env: { NODE_ENV: "test" },
  })
  f.exit(1)
  setImmediate(() => {
    const bytes = Buffer.from("启动失败: MODULE_NOT_FOUND\n")
    f.stderr.write(bytes.subarray(0, 2))
    f.stderr.end(bytes.subarray(2))
  })
  await expect(boot).rejects.toThrow("启动失败: MODULE_NOT_FOUND")
})

it("does not wait indefinitely for an unclosed diagnostic pipe", async () => {
  jest.useFakeTimers()
  try {
    const f = fakeChild()
    const boot = bootstrapSidecar({
      scriptPath: "/x/host.mjs",
      spawn: () => f.child,
      env: { NODE_ENV: "test" },
    })
    const rejected = expect(boot).rejects.toThrow("MODULE_NOT_FOUND")
    f.stderr.write("MODULE_NOT_FOUND")
    f.exit(1)
    await jest.advanceTimersByTimeAsync(100)
    await rejected
    expect(f.kill).toHaveBeenCalledTimes(1)
  } finally {
    jest.useRealTimers()
  }
})

it("handles a broken stderr stream and keeps a useful generic failure when no diagnostic exists", async () => {
  const f = fakeChild()
  const boot = bootstrapSidecar({
    scriptPath: "/x/host.mjs",
    spawn: () => f.child,
    env: { NODE_ENV: "test" },
  })
  f.stderr.emit("error", new Error("EIO"))
  f.exit(1)
  await expect(boot).rejects.toThrow(/^sidecar exited before ready$/)
})

it("masks bare multiline secret environment values and removes terminal escape sequences", async () => {
  const f = fakeChild()
  const boot = bootstrapSidecar({
    scriptPath: "/x/host.mjs",
    spawn: () => f.child,
    env: {
      NODE_ENV: "test",
      PRIVATE_KEY: "private-line-one\nprivate-line-two",
      CREDENTIAL: "opaque-value",
      EMPTY_TOKEN: "",
    },
  })
  f.stderr.end(
    "private-line-one\nprivate-line-two\nopaque-value\n\x1b[31mMODULE_NOT_FOUND\x1b[0m\n"
  )
  f.exit(1)
  const error = (await boot.catch((err: Error) => err)) as Error
  expect(error.message).toContain("MODULE_NOT_FOUND")
  expect(error.message).not.toMatch(/private-line|opaque-value|\x1b/)
})

it("keeps startup diagnostics available for readiness timeouts and tolerates a failing kill", async () => {
  const f = fakeChild()
  f.kill.mockImplementation(() => {
    throw new Error("already gone")
  })
  const boot = bootstrapSidecar({
    scriptPath: "/x/host.mjs",
    spawn: () => f.child,
    readyTimeoutMs: 10,
    env: { NODE_ENV: "test" },
  })
  f.stderr.end("loader stalled\n")
  await expect(boot).rejects.toThrow(/did not become ready[\s\S]*loader stalled/)
})

it("uses piped stderr in the real Node spawn path", async () => {
  const f = fakeChild()
  jest.mocked(nodeSpawn).mockImplementationOnce((() => {
    setImmediate(() => f.stdout.write('{"type":"ready"}\n'))
    return f.child
  }) as never)
  const boot = await bootstrapSidecar({
    scriptPath: "/x/host.mjs",
    cwd: "/work",
    env: { NODE_ENV: "test" },
  })
  expect(nodeSpawn).toHaveBeenLastCalledWith(
    "node",
    ["/x/host.mjs"],
    expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] })
  )
  await boot.shutdown()
})

it("captures Bun standalone startup stderr without inheriting unredacted output", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "Bun")
  let stderr!: ReadableStreamDefaultController<Uint8Array>
  let rejectExit!: (error: unknown) => void
  const spawn = jest.fn(() => ({
    stdin: { write: jest.fn() },
    stdout: new ReadableStream<Uint8Array>(),
    stderr: new ReadableStream<Uint8Array>({
      start(controller) {
        stderr = controller
      },
    }),
    exited: new Promise<number>((_resolve, reject) => {
      rejectExit = reject
    }),
    kill: jest.fn(),
  }))
  Object.defineProperty(globalThis, "Bun", {
    configurable: true,
    value: { isStandaloneExecutable: true, spawn },
  })
  try {
    const boot = bootstrapSidecar({ scriptPath: "/dist/host.mjs", env: { NODE_ENV: "test" } })
    stderr.enqueue(
      new TextEncoder().encode("MODULE_NOT_FOUND @babel/traverse\nTOKEN=secret-value\n")
    )
    stderr.close()
    rejectExit("spawn failed")
    const error = (await boot.catch((err: Error) => err)) as Error
    expect(error.message).toContain("@babel/traverse")
    expect(error.message).not.toContain("secret-value")
    expect(spawn).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ stderr: "pipe" })
    )
  } finally {
    if (original) Object.defineProperty(globalThis, "Bun", original)
    else Reflect.deleteProperty(globalThis, "Bun")
  }
})

it("reports a missing sidecar installation when no candidate script exists", () => {
  expect(() =>
    resolveSidecarScript({}, { execPath: "/missing/cognia", exists: () => false })
  ).toThrow("set COGNIA_SIDECAR_SCRIPT")
})

it.each([new Error("EPIPE"), "EPIPE"])(
  "normalizes Bun stdin failures without losing teardown when stdin end also throws: %s",
  (failure) => {
    const kill = jest.fn()
    const child = adaptBunSubprocess({
      stdin: {
        write() {
          throw failure
        },
        end() {
          throw new Error("closed")
        },
      },
      stdout: new ReadableStream<Uint8Array>(),
      exited: new Promise(() => {}),
      kill,
    })
    const onError = jest.fn()
    child.stdin?.on?.("error", onError)
    child.stdin?.write("send\n")
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "EPIPE" }))
    child.kill()
    expect(kill).toHaveBeenCalledTimes(1)
  }
)

it("tolerates already-dead children on shutdown and consumes decoded-string stderr", async () => {
  const f = fakeChild()
  f.stderr.setEncoding("utf8")
  f.kill.mockImplementation(() => {
    throw new Error("already dead")
  })
  const booting = bootstrapSidecar({
    scriptPath: "/x/host.mjs",
    spawn: () => f.child,
    env: { NODE_ENV: "test" },
  })
  f.stderr.write("startup log\n")
  f.stdout.write('{"type":"ready"}\n')
  const boot = await booting
  await expect(boot.shutdown()).resolves.toBeUndefined()
  await boot.shutdown()
  expect(f.kill).toHaveBeenCalledTimes(1)
})
