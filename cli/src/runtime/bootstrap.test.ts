/**
 * @jest-environment node
 */
import { PassThrough } from "node:stream"

import { transport as installedTransport } from "@/lib/tauri"

import { bootstrapSidecar, resolveSidecarScript, type SpawnFn } from "./bootstrap"
import { StdioTransport } from "./stdio-transport"

function fakeChild() {
  const stdout = new PassThrough()
  const writes: string[] = []
  let exitCb: ((code: number | null) => void) | null = null
  const kill = jest.fn()
  const child = {
    stdin: { write: (c: string) => void writes.push(c) },
    stdout,
    on: (_e: "exit", cb: (code: number | null) => void) => {
      exitCb = cb
      return child
    },
    kill,
  }
  return { child, stdout, writes, kill, exit: (c = 0) => exitCb?.(c) }
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
})

describe("bootstrapSidecar", () => {
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
