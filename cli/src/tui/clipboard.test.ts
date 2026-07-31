/** @jest-environment node */
import { EventEmitter } from "node:events"

import {
  clipboardCommand,
  clipboardFailureMessage,
  copyToClipboard,
  osc52Sequence,
  wrapForMultiplexer,
} from "./clipboard"

/** No-SSH env so `auto` mode takes the native-helper path in these tests. */
const localEnv = {} as NodeJS.ProcessEnv

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
    const ok = await copyToClipboard("hello", { platform: "darwin", spawn, env: localEnv })
    expect(ok).toEqual({ ok: true })
    expect(captured).toBe("hello")
  })

  it("resolves false on a non-zero exit (osc52 never)", async () => {
    const spawn = (() => fakeChild(1)) as unknown as typeof import("node:child_process").spawn
    expect(await copyToClipboard("x", { platform: "win32", spawn, osc52: "never" })).toEqual({
      ok: false,
      reason: "unavailable",
    })
  })

  it("resolves false on a spawn error event (osc52 never)", async () => {
    const spawn = (() => {
      const ee = new EventEmitter() as EventEmitter & { stdin: { end: () => void } }
      ee.stdin = { end: () => {} }
      queueMicrotask(() => ee.emit("error", new Error("ENOENT")))
      return ee
    }) as unknown as typeof import("node:child_process").spawn
    expect(await copyToClipboard("x", { platform: "linux", spawn, osc52: "never" })).toEqual({
      ok: false,
      reason: "unavailable",
    })
  })

  it("resolves false when the platform is unsupported (osc52 never)", async () => {
    const spawn = jest.fn() as unknown as typeof import("node:child_process").spawn
    expect(
      await copyToClipboard("x", { platform: "aix" as NodeJS.Platform, spawn, osc52: "never" })
    ).toEqual({ ok: false, reason: "unavailable" })
    expect(spawn).not.toHaveBeenCalled()
  })

  it("defaults the platform to process.platform when omitted", async () => {
    let called = false
    const spawn = (() => {
      called = true
      return fakeChild(0)
    }) as unknown as typeof import("node:child_process").spawn
    // process.platform on the host is a supported clipboard target → spawns
    // (a non-SSH env keeps `auto` on the native path).
    await copyToClipboard("x", { spawn, env: localEnv })
    expect(called).toBe(true)
  })

  it("never invokes the spawner for an unsupported platform in osc52 never mode", async () => {
    expect(
      await copyToClipboard("x", { platform: "aix" as NodeJS.Platform, osc52: "never" })
    ).toEqual({ ok: false, reason: "unavailable" })
  })

  it("tolerates a child with no stdin and still resolves on close", async () => {
    const spawn = (() => {
      const ee = new EventEmitter() as EventEmitter & { stdin?: undefined }
      ee.stdin = undefined
      queueMicrotask(() => ee.emit("close", 0))
      return ee
    }) as unknown as typeof import("node:child_process").spawn
    expect(await copyToClipboard("x", { platform: "darwin", spawn, env: localEnv })).toEqual({
      ok: true,
    })
  })

  it("resolves false when spawn throws synchronously (osc52 never)", async () => {
    const spawn = (() => {
      throw new Error("boom")
    }) as unknown as typeof import("node:child_process").spawn
    expect(await copyToClipboard("x", { platform: "darwin", spawn, osc52: "never" })).toEqual({
      ok: false,
      reason: "unavailable",
    })
  })
})

describe("osc52Sequence", () => {
  it("wraps base64 in the OSC 52 set-clipboard escape", () => {
    expect(osc52Sequence("hi")).toBe(`\x1b]52;c;${Buffer.from("hi").toString("base64")}\x07`)
  })
})

describe("wrapForMultiplexer", () => {
  it("passes the sequence through untouched outside tmux", () => {
    expect(wrapForMultiplexer("\x1b]52;c;AA\x07", localEnv)).toBe("\x1b]52;c;AA\x07")
  })
  it("wraps in a tmux DCS passthrough with inner ESCs doubled", () => {
    expect(
      wrapForMultiplexer("\x1b]52;c;AA\x07", {
        TMUX: "/tmp/tmux-0/default",
      } as unknown as NodeJS.ProcessEnv)
    ).toBe("\x1bPtmux;\x1b\x1b]52;c;AA\x07\x1b\\")
  })
})

describe("copyToClipboard — OSC 52", () => {
  const neverSpawn = (() => {
    throw new Error("spawn must not run")
  }) as unknown as typeof import("node:child_process").spawn

  it("always mode writes OSC 52 and skips the native helper", async () => {
    let written = ""
    const ok = await copyToClipboard("hello", {
      platform: "darwin",
      spawn: neverSpawn,
      osc52: "always",
      write: (d) => (written = d),
    })
    expect(ok).toEqual({ ok: true })
    expect(written).toBe(osc52Sequence("hello"))
  })

  it("auto mode prefers OSC 52 when SSH is detected", async () => {
    let written = ""
    const ok = await copyToClipboard("remote", {
      platform: "linux",
      spawn: neverSpawn,
      env: { SSH_TTY: "/dev/pts/0" } as unknown as NodeJS.ProcessEnv,
      write: (d) => (written = d),
    })
    expect(ok).toEqual({ ok: true })
    expect(written).toBe(osc52Sequence("remote"))
  })

  it("auto mode uses OSC 52 when the platform has no native helper", async () => {
    let written = ""
    const ok = await copyToClipboard("x", {
      platform: "aix" as NodeJS.Platform,
      env: localEnv,
      write: (d) => (written = d),
    })
    expect(ok).toEqual({ ok: true })
    expect(written).toBe(osc52Sequence("x"))
  })

  it("auto mode falls back to OSC 52 when the native helper fails", async () => {
    let written = ""
    const spawn = (() => {
      const ee = new EventEmitter() as EventEmitter & { stdin: { end: () => void } }
      ee.stdin = { end: () => {} }
      queueMicrotask(() => ee.emit("close", 1))
      return ee
    }) as unknown as typeof import("node:child_process").spawn
    const ok = await copyToClipboard("fb", {
      platform: "darwin",
      spawn,
      env: localEnv,
      write: (d) => (written = d),
    })
    expect(ok).toEqual({ ok: true })
    expect(written).toBe(osc52Sequence("fb"))
  })

  it("wraps the OSC 52 escape in a tmux passthrough when inside tmux", async () => {
    let written = ""
    const ok = await copyToClipboard("hi", {
      platform: "linux",
      osc52: "always",
      env: { TMUX: "/tmp/tmux-0/default" } as unknown as NodeJS.ProcessEnv,
      write: (d) => (written = d),
    })
    expect(ok).toEqual({ ok: true })
    expect(written).toBe(
      wrapForMultiplexer(osc52Sequence("hi"), { TMUX: "x" } as unknown as NodeJS.ProcessEnv)
    )
  })

  it("reports false when the OSC 52 writer throws", async () => {
    const ok = await copyToClipboard("x", {
      platform: "darwin",
      osc52: "always",
      write: () => {
        throw new Error("no tty")
      },
    })
    expect(ok).toEqual({ ok: false, reason: "unavailable" })
  })
})

describe("copyToClipboard — OSC 52 size threshold", () => {
  it("skips the OSC 52 escape when the payload exceeds osc52MaxBytes", async () => {
    let written = ""
    const ok = await copyToClipboard("abcdef", {
      platform: "darwin",
      osc52: "always",
      osc52MaxBytes: 3,
      write: (d) => (written = d),
    })
    expect(ok).toEqual({ ok: false, reason: "too-large" })
    expect(written).toBe("") // never emitted a doomed escape
  })

  it("counts UTF-8 BYTES, not characters, against the cap", async () => {
    // "你好" is 2 chars but 6 UTF-8 bytes — over a 4-byte cap.
    const ok = await copyToClipboard("你好", {
      platform: "linux",
      osc52: "always",
      osc52MaxBytes: 4,
      write: () => {},
    })
    expect(ok).toEqual({ ok: false, reason: "too-large" })
  })

  it("emits when the payload is within osc52MaxBytes", async () => {
    let written = ""
    const ok = await copyToClipboard("hi", {
      platform: "darwin",
      osc52: "always",
      osc52MaxBytes: 16,
      write: (d) => (written = d),
    })
    expect(ok).toEqual({ ok: true })
    expect(written).toBe(osc52Sequence("hi"))
  })

  it("treats osc52MaxBytes: 0 as no cap (disabled)", async () => {
    let written = ""
    const ok = await copyToClipboard("a very long payload that would otherwise trip a tiny cap", {
      platform: "darwin",
      osc52: "always",
      osc52MaxBytes: 0,
      write: (d) => (written = d),
    })
    expect(ok).toEqual({ ok: true })
    expect(written).not.toBe("")
  })

  it("falls back to too-large (not unavailable) when the helper fails and OSC 52 is over cap", async () => {
    // Auto mode, native helper exits non-zero, then the OSC 52 fallback is too big.
    const spawn = (() => {
      const ee = new EventEmitter() as EventEmitter & { stdin: { end: () => void } }
      ee.stdin = { end: () => {} }
      queueMicrotask(() => ee.emit("close", 1))
      return ee
    }) as unknown as typeof import("node:child_process").spawn
    const ok = await copyToClipboard("oversized", {
      platform: "darwin",
      spawn,
      env: localEnv,
      osc52MaxBytes: 2,
      write: () => {},
    })
    expect(ok).toEqual({ ok: false, reason: "too-large" })
  })

  it("still succeeds via the native helper even when OSC 52 would be over cap", async () => {
    // The cap gates only the OSC 52 path; a working local helper is unaffected.
    let captured = ""
    const spawn = (() => {
      const ee = new EventEmitter() as EventEmitter & { stdin: { end: (t: string) => void } }
      ee.stdin = { end: (t: string) => (captured = t) }
      queueMicrotask(() => ee.emit("close", 0))
      return ee
    }) as unknown as typeof import("node:child_process").spawn
    const ok = await copyToClipboard("oversized", {
      platform: "darwin",
      spawn,
      env: localEnv,
      osc52MaxBytes: 2,
    })
    expect(ok).toEqual({ ok: true })
    expect(captured).toBe("oversized")
  })
})

describe("clipboardFailureMessage", () => {
  const notices = { clipboardUnavailable: "nope", clipboardTooLarge: "too big" }
  it("maps too-large to the too-large notice", () => {
    expect(clipboardFailureMessage("too-large", notices)).toBe("too big")
  })
  it("maps unavailable to the unavailable notice", () => {
    expect(clipboardFailureMessage("unavailable", notices)).toBe("nope")
  })
})
