import { BELL, NOTIFY_MIN_MS, shouldNotifyOnDone, emitCompletionBell } from "./notify"
import type { TitleStream } from "./terminal-title"

describe("shouldNotifyOnDone", () => {
  it("fires only when enabled and the turn ran long enough", () => {
    expect(shouldNotifyOnDone(true, NOTIFY_MIN_MS)).toBe(true)
    expect(shouldNotifyOnDone(true, NOTIFY_MIN_MS + 1)).toBe(true)
    expect(shouldNotifyOnDone(true, NOTIFY_MIN_MS - 1)).toBe(false)
    expect(shouldNotifyOnDone(false, 999999)).toBe(false)
  })

  it("honors a custom minimum", () => {
    expect(shouldNotifyOnDone(true, 100, 50)).toBe(true)
    expect(shouldNotifyOnDone(true, 100, 200)).toBe(false)
  })
})

describe("emitCompletionBell", () => {
  function sink(isTTY?: boolean): TitleStream & { written: string[] } {
    const written: string[] = []
    return { isTTY, write: (d: string) => written.push(d), written }
  }

  it("writes the BEL on a real TTY", () => {
    const out = sink(true)
    emitCompletionBell(out, { TERM: "xterm" })
    expect(out.written).toEqual([BELL])
  })

  it("writes the BEL when env has no TERM set", () => {
    const out = sink(true)
    emitCompletionBell(out, {})
    expect(out.written).toEqual([BELL])
  })

  it("is a no-op on a non-TTY or dumb terminal", () => {
    const noTty = sink(false)
    emitCompletionBell(noTty, { TERM: "xterm" })
    expect(noTty.written).toEqual([])

    const dumb = sink(true)
    emitCompletionBell(dumb, { TERM: "dumb" })
    expect(dumb.written).toEqual([])
  })
})
