/**
 * @jest-environment node
 */
import { PassThrough } from "node:stream"
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
        stderr: "inherit",
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
