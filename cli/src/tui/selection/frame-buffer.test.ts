import { EventEmitter } from "node:events"
import { Stream } from "node:stream"

import { createFrameBuffer } from "./frame-buffer"

/** A `process.stdout`-shaped stub that records writes and satisfies Ink's
 * `stdout instanceof Stream` check through the proxy. */
class FakeStdout extends Stream {
  writes: string[] = []
  isTTY = true
  columns = 80
  rows = 24
  write(data: string): boolean {
    this.writes.push(data)
    return true
  }
  /** Reads `this.columns` through `this`, so a wrong proxy receiver shows up. */
  describe(): string {
    return `${this.columns}x${this.rows}`
  }
}

describe("createFrameBuffer", () => {
  it("forwards every write to the underlying stream untouched", () => {
    const base = new FakeStdout()
    const fb = createFrameBuffer(base)
    fb.stdout.write("\x1b[?1049h")
    fb.stdout.write("frame")
    expect(base.writes).toEqual(["\x1b[?1049h", "frame"])
  })

  it("captures a committed frame as styled and plain lines", () => {
    const base = new FakeStdout()
    const fb = createFrameBuffer(base)
    fb.stdout.write("\x1b[31mred\x1b[0m\nplain")
    expect(fb.frame()).toEqual(["\x1b[31mred\x1b[0m", "plain"])
    expect(fb.plain()).toEqual(["red", "plain"])
  })

  it("strips log-update's leading erase run from the stored frame", () => {
    const base = new FakeStdout()
    const fb = createFrameBuffer(base)
    fb.stdout.write("\x1b[2K\x1b[1A\x1b[2K\x1b[Gfirst\nsecond")
    expect(fb.frame()).toEqual(["first", "second"])
  })

  it("strips the cursor prefix AND suffix Ink can wrap a frame in", () => {
    const base = new FakeStdout()
    const fb = createFrameBuffer(base)
    // hide-cursor + return-to-bottom prefix, erase run, frame, reposition suffix.
    fb.stdout.write(
      "\x1b[?25l\x1b[1B\x1b[1G\x1b[2K\x1b[1A\x1b[2K\x1b[Gfirst\nsecond\x1b[1A\x1b[3G\x1b[?25h"
    )
    expect(fb.frame()).toEqual(["first", "second"])
    expect(fb.plain()).toEqual(["first", "second"])
  })

  it("leaves the stored frame alone for control-only writes", () => {
    const base = new FakeStdout()
    const fb = createFrameBuffer(base)
    fb.stdout.write("body")
    fb.stdout.write("\x1b[?1000h\x1b[?1006h") // mouse tracking
    fb.stdout.write("\x1b]52;c;aGk=\x07") // OSC 52 clipboard write
    fb.stdout.write("\x1b[?2026h") // synchronized update marker
    expect(fb.frame()).toEqual(["body"])
    expect(base.writes).toHaveLength(4)
  })

  it("starts empty before the first frame", () => {
    const fb = createFrameBuffer(new FakeStdout())
    expect(fb.frame()).toEqual([])
    expect(fb.plain()).toEqual([])
  })

  it("notifies subscribers once per committed frame, and not for control writes", () => {
    const fb = createFrameBuffer(new FakeStdout())
    const seen: number[] = []
    const off = fb.onFrame(() => seen.push(fb.plain().length))
    fb.stdout.write("a\nb")
    fb.stdout.write("\x1b[?1002l")
    fb.stdout.write("only")
    expect(seen).toEqual([2, 1])
    off()
    fb.stdout.write("c")
    expect(seen).toEqual([2, 1])
  })

  it("raw() bypasses capture so a repaint is never mistaken for a frame", () => {
    const base = new FakeStdout()
    const fb = createFrameBuffer(base)
    fb.stdout.write("real frame")
    fb.raw("\x1b7\x1b[3;1Hoverlay\x1b[K\x1b8")
    expect(fb.frame()).toEqual(["real frame"])
    expect(base.writes).toHaveLength(2)
  })

  it("delegates non-write properties to the real stream", () => {
    const base = new FakeStdout()
    const fb = createFrameBuffer(base)
    expect(fb.stdout.isTTY).toBe(true)
    expect(fb.stdout.columns).toBe(80)
    expect(fb.stdout.rows).toBe(24)
    // Ink's `getOptions` gates on this, so the proxy must keep the prototype chain.
    expect(fb.stdout instanceof Stream).toBe(true)
    expect(fb.stdout instanceof EventEmitter).toBe(true)
  })

  it("binds delegated methods to the real stream, with a stable identity", () => {
    const base = new FakeStdout()
    const fb = createFrameBuffer(base)
    // A wrong receiver would read `columns` off the proxy's own properties.
    expect((fb.stdout as unknown as FakeStdout).describe()).toBe("80x24")
    // Ink registers then removes a resize listener, so `on`/`off` must be the
    // same function object across gets.
    expect(fb.stdout.on).toBe(fb.stdout.on)
  })

  it("keeps the underlying resize events working through the proxy", () => {
    const base = new FakeStdout()
    const fb = createFrameBuffer(base)
    const onResize = jest.fn()
    fb.stdout.on("resize", onResize)
    base.emit("resize")
    expect(onResize).toHaveBeenCalledTimes(1)
    fb.stdout.off("resize", onResize)
    base.emit("resize")
    expect(onResize).toHaveBeenCalledTimes(1)
  })
})
