/** @jest-environment node */
import { EventEmitter } from "node:events"

import { clipboardCommand, copyToClipboard } from "./clipboard"

describe("clipboardCommand", () => {
  it("maps each supported platform", () => {
    expect(clipboardCommand("win32")).toEqual({ cmd: "clip", args: [] })
    expect(clipboardCommand("darwin")).toEqual({ cmd: "pbcopy", args: [] })
    expect(clipboardCommand("linux")).toEqual({ cmd: "xclip", args: ["-selection", "clipboard"] })
  })

  it("returns null for an unsupported platform", () => {
    expect(clipboardCommand("aix" as NodeJS.Platform)).toBeNull()
  })
})

/** A fake child process that records the piped text and a scripted close code. */
function fakeChild(code: number) {
  const ee = new EventEmitter() as EventEmitter & {
    stdin: { end: (t: string) => void }
    written?: string
  }
  ee.stdin = { end: (t: string) => (ee.written = t) }
  queueMicrotask(() => ee.emit("close", code))
  return ee
}

describe("copyToClipboard", () => {
  it("pipes the text and resolves true on a clean exit", async () => {
    let captured = ""
    const spawn = ((_cmd: string, _args: string[]) => {
      const child = fakeChild(0)
      const origEnd = child.stdin.end
      child.stdin.end = (t: string) => {
        captured = t
        origEnd(t)
      }
      return child
    }) as unknown as typeof import("node:child_process").spawn
    const ok = await copyToClipboard("hello", { platform: "darwin", spawn })
    expect(ok).toBe(true)
    expect(captured).toBe("hello")
  })

  it("resolves false on a non-zero exit", async () => {
    const spawn = (() => fakeChild(1)) as unknown as typeof import("node:child_process").spawn
    expect(await copyToClipboard("x", { platform: "win32", spawn })).toBe(false)
  })

  it("resolves false on a spawn error event", async () => {
    const spawn = (() => {
      const ee = new EventEmitter() as EventEmitter & { stdin: { end: () => void } }
      ee.stdin = { end: () => {} }
      queueMicrotask(() => ee.emit("error", new Error("ENOENT")))
      return ee
    }) as unknown as typeof import("node:child_process").spawn
    expect(await copyToClipboard("x", { platform: "linux", spawn })).toBe(false)
  })

  it("resolves false when the platform is unsupported", async () => {
    const spawn = jest.fn() as unknown as typeof import("node:child_process").spawn
    expect(await copyToClipboard("x", { platform: "aix" as NodeJS.Platform, spawn })).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
  })

  it("defaults the platform to process.platform when omitted", async () => {
    let called = false
    const spawn = (() => {
      called = true
      return fakeChild(0)
    }) as unknown as typeof import("node:child_process").spawn
    // process.platform on the host is a supported clipboard target → spawns.
    await copyToClipboard("x", { spawn })
    expect(called).toBe(true)
  })

  it("defaults the spawner to the real one but never invokes it for an unsupported platform", async () => {
    // No `spawn` injected → the default is selected; the unsupported platform
    // short-circuits before it is ever called, so no real process is started.
    expect(await copyToClipboard("x", { platform: "aix" as NodeJS.Platform })).toBe(false)
  })

  it("tolerates a child with no stdin and still resolves on close", async () => {
    const spawn = (() => {
      const ee = new EventEmitter() as EventEmitter & { stdin?: undefined }
      ee.stdin = undefined
      queueMicrotask(() => ee.emit("close", 0))
      return ee
    }) as unknown as typeof import("node:child_process").spawn
    expect(await copyToClipboard("x", { platform: "darwin", spawn })).toBe(true)
  })

  it("resolves false when spawn throws synchronously", async () => {
    const spawn = (() => {
      throw new Error("boom")
    }) as unknown as typeof import("node:child_process").spawn
    expect(await copyToClipboard("x", { platform: "darwin", spawn })).toBe(false)
  })
})
