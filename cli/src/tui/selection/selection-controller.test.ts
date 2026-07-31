import { createSelectionController, type SelectionController } from "./selection-controller"
import { stripAnsi } from "./ansi-columns"
import { createFrameBuffer } from "./frame-buffer"
import type { FrameBuffer } from "./frame-buffer"
import type { MouseEvent } from "../input/mouse"
import type { SelectionMode } from "../../config/schema"
import type { CopyResult } from "../clipboard"

const NO_MODS = { ctrl: false, alt: false, shift: false }

/** SGR coordinates are 1-based; the controller converts with a `-1`. */
function press(row: number, col: number): MouseEvent {
  return { kind: "click", row, col, mods: NO_MODS }
}
function drag(row: number, col: number): MouseEvent {
  return { kind: "drag", row, col, mods: NO_MODS }
}
function release(row: number, col: number): MouseEvent {
  return { kind: "release", row, col, mods: NO_MODS }
}

interface Harness {
  controller: SelectionController
  /** Everything the controller wrote straight to the terminal. */
  painted: string[]
  copied: string[]
  copiedChars: number[]
  failures: string[]
  setMode: (mode: SelectionMode) => void
  setClock: (at: number) => void
  /** Simulate Ink committing a new frame (wipes the highlight, fires onFrame). */
  commitFrame: (lines: string[]) => void
}

function harness(
  lines: string[] = ["hello world", "second line"],
  opts: { mode?: SelectionMode; copyResult?: CopyResult } = {}
): Harness {
  let mode: SelectionMode = opts.mode ?? "auto-copy"
  let clock = 1000
  let frameLines = lines
  const painted: string[] = []
  const copied: string[] = []
  const copiedChars: number[] = []
  const failures: string[] = []
  const listeners = new Set<() => void>()

  const frames: FrameBuffer = {
    stdout: null as never,
    frame: () => frameLines,
    plain: () => frameLines.map(stripAnsi),
    raw: (data) => void painted.push(data),
    onFrame: (cb) => {
      listeners.add(cb)
      return () => void listeners.delete(cb)
    },
  }

  const controller = createSelectionController({
    frames,
    mode: () => mode,
    copy: (text) => {
      copied.push(text)
      return opts.copyResult ?? { ok: true }
    },
    onCopied: (chars) => void copiedChars.push(chars),
    onCopyFailed: (reason) => void failures.push(reason),
    now: () => clock,
  })

  return {
    controller,
    painted,
    copied,
    copiedChars,
    failures,
    setMode: (next) => {
      mode = next
    },
    setClock: (at) => {
      clock = at
    },
    commitFrame: (next) => {
      frameLines = next
      for (const cb of listeners) cb()
    },
  }
}

/** Let the controller's copy promise settle. */
const flush = () => new Promise((resolve) => setImmediate(resolve))

describe("createSelectionController", () => {
  it("declines every event while the mode is off", () => {
    const h = harness(undefined, { mode: "off" })
    expect(h.controller.handleMouse(press(1, 1))).toBe(false)
    expect(h.controller.handleMouse(drag(1, 5))).toBe(false)
    expect(h.controller.handleMouse(release(1, 5))).toBe(false)
    expect(h.painted).toEqual([])
  })

  it("declines a first plain press so single-click behaviour is untouched", () => {
    const h = harness()
    expect(h.controller.handleMouse(press(1, 3))).toBe(false)
    expect(h.painted).toEqual([])
  })

  it("treats a press and release on the same cell as a plain click", () => {
    const h = harness()
    h.controller.handleMouse(press(1, 3))
    expect(h.controller.handleMouse(release(1, 3))).toBe(false)
    expect(h.controller.hasSelection()).toBe(false)
    expect(h.copied).toEqual([])
  })

  it("paints a drag and copies it on release in auto-copy mode", async () => {
    const h = harness()
    h.controller.handleMouse(press(1, 7))
    expect(h.controller.handleMouse(drag(1, 11))).toBe(true)
    expect(h.painted).toHaveLength(1)
    expect(stripAnsi(h.painted[0])).toContain("hello world")
    expect(h.controller.handleMouse(release(1, 11))).toBe(true)
    await flush()
    expect(h.copied).toEqual(["world"])
    expect(h.copiedChars).toEqual([5])
    // auto-copy drops the highlight once the text is on the clipboard.
    expect(h.controller.hasSelection()).toBe(false)
  })

  it("keeps the selection after release in manual mode, until the chord copies", async () => {
    const h = harness(undefined, { mode: "manual" })
    h.controller.handleMouse(press(1, 7))
    h.controller.handleMouse(drag(1, 11))
    h.controller.handleMouse(release(1, 11))
    await flush()
    expect(h.copied).toEqual([])
    expect(h.controller.hasSelection()).toBe(true)
    expect(h.controller.copySelection()).toBe(true)
    await flush()
    expect(h.copied).toEqual(["world"])
  })

  it("copySelection reports false when nothing is selected", () => {
    const h = harness()
    expect(h.controller.copySelection()).toBe(false)
    expect(h.copied).toEqual([])
  })

  it("surfaces a clipboard failure instead of a success notice", async () => {
    const h = harness(undefined, { copyResult: { ok: false, reason: "too-large" } })
    h.controller.handleMouse(press(1, 1))
    h.controller.handleMouse(drag(1, 5))
    h.controller.handleMouse(release(1, 5))
    await flush()
    expect(h.copiedChars).toEqual([])
    expect(h.failures).toEqual(["too-large"])
  })

  it("consumes the repeat press of a double-click and snaps to the word", async () => {
    const h = harness(undefined, { mode: "manual" })
    h.controller.handleMouse(press(1, 8)) // first press: falls through
    h.controller.handleMouse(release(1, 8))
    expect(h.controller.handleMouse(press(1, 8))).toBe(true) // double-click
    h.controller.handleMouse(release(1, 8))
    h.controller.copySelection()
    await flush()
    expect(h.copied).toEqual(["world"])
  })

  it("takes the whole row on a triple-click", async () => {
    const h = harness(undefined, { mode: "manual" })
    h.controller.handleMouse(press(2, 4))
    h.controller.handleMouse(release(2, 4))
    h.controller.handleMouse(press(2, 4)) // word
    h.controller.handleMouse(release(2, 4))
    h.controller.handleMouse(press(2, 4)) // line
    h.controller.handleMouse(release(2, 4))
    h.controller.copySelection()
    await flush()
    expect(h.copied).toEqual(["second line"])
  })

  it("restarts at char granularity once the multi-click window lapses", () => {
    const h = harness(undefined, { mode: "manual" })
    h.controller.handleMouse(press(1, 8))
    h.controller.handleMouse(release(1, 8))
    h.setClock(9999)
    // Too slow to be a double-click ⇒ a plain press, which is not consumed.
    expect(h.controller.handleMouse(press(1, 8))).toBe(false)
  })

  it("repaints only the rows whose highlight changed", () => {
    const h = harness()
    h.controller.handleMouse(press(1, 1))
    h.controller.handleMouse(drag(2, 3))
    h.painted.length = 0
    // Shrinking back to row 1 must restore row 2 as well as redraw row 1.
    h.controller.handleMouse(drag(1, 3))
    expect(h.painted).toHaveLength(1)
    expect(h.painted[0]).toContain("\x1b[1;1H")
    expect(h.painted[0]).toContain("\x1b[2;1H")
  })

  it("wraps every repaint in a cursor save/restore", () => {
    const h = harness()
    h.controller.handleMouse(press(1, 1))
    h.controller.handleMouse(drag(1, 5))
    expect(h.painted[0].startsWith("\x1b7")).toBe(true)
    expect(h.painted[0].endsWith("\x1b8")).toBe(true)
  })

  it("ignores a drag that never left the current head cell", () => {
    const h = harness()
    h.controller.handleMouse(press(1, 1))
    h.controller.handleMouse(drag(1, 5))
    const before = h.painted.length
    h.controller.handleMouse(drag(1, 5))
    expect(h.painted).toHaveLength(before)
  })

  it("re-asserts the highlight after Ink commits a new frame", () => {
    const h = harness()
    h.controller.handleMouse(press(1, 1))
    h.controller.handleMouse(drag(1, 5))
    h.painted.length = 0
    h.commitFrame(["hello world", "second line"])
    expect(h.painted).toHaveLength(1)
    expect(h.painted[0]).toContain("\x1b[1;1H")
  })

  it("does not repaint on a frame commit when nothing is selected", () => {
    const h = harness()
    h.commitFrame(["a", "b"])
    expect(h.painted).toEqual([])
  })

  it("clear() restores the painted rows and reports whether there was a selection", () => {
    const h = harness(undefined, { mode: "manual" })
    expect(h.controller.clear()).toBe(false)
    h.controller.handleMouse(press(1, 1))
    h.controller.handleMouse(drag(1, 5))
    h.painted.length = 0
    expect(h.controller.clear()).toBe(true)
    expect(h.painted).toHaveLength(1)
    expect(h.painted[0]).not.toContain("\x1b[7m")
    expect(h.controller.hasSelection()).toBe(false)
  })

  it("a new press supersedes the previous selection", () => {
    const h = harness(undefined, { mode: "manual" })
    h.controller.handleMouse(press(1, 1))
    h.controller.handleMouse(drag(1, 5))
    h.painted.length = 0
    h.controller.handleMouse(press(2, 1))
    // The old highlight is restored before the new gesture begins.
    expect(h.painted).toHaveLength(1)
    expect(h.painted[0]).not.toContain("\x1b[7m")
  })

  it("swallows a drag that arrives with no armed anchor", () => {
    const h = harness()
    expect(h.controller.handleMouse(drag(1, 4))).toBe(false)
    expect(h.controller.handleMouse(release(1, 4))).toBe(false)
  })

  it("ignores wheel and other mouse events", () => {
    const h = harness()
    expect(h.controller.handleMouse({ kind: "wheel", dir: "up" })).toBe(false)
    expect(h.controller.handleMouse({ kind: "other" })).toBe(false)
  })

  it("skips a row the frame no longer has", () => {
    const h = harness(undefined, { mode: "manual" })
    h.controller.handleMouse(press(2, 1))
    h.controller.handleMouse(drag(2, 5))
    h.painted.length = 0
    // The transcript shrank under the selection — the stale row is simply dropped.
    h.commitFrame(["only one row"])
    expect(h.painted).toEqual([])
  })

  it("dispose() stops re-asserting the highlight on later frames", () => {
    const h = harness()
    h.controller.handleMouse(press(1, 1))
    h.controller.handleMouse(drag(1, 5))
    h.controller.dispose()
    h.painted.length = 0
    h.commitFrame(["hello world", "second line"])
    expect(h.painted).toEqual([])
  })
})

/**
 * The two halves against each other, over the wire format Ink actually emits:
 * a full frame wrapped in log-update's erase run. The fakes above pin the
 * controller's logic; this pins the CONTRACT between it and the frame buffer —
 * the seam where a change to the strip/split rules would silently start
 * copying the wrong text.
 */
describe("selection over a real frame buffer", () => {
  const ERASE = "\x1b[2K\x1b[1A\x1b[2K\x1b[G"

  function wired(mode: SelectionMode = "auto-copy") {
    const terminal: string[] = []
    const copied: string[] = []
    const frames = createFrameBuffer({ write: (d: string) => terminal.push(d) })
    const controller = createSelectionController({
      frames,
      mode: () => mode,
      copy: (text) => {
        copied.push(text)
        return { ok: true }
      },
      onCopied: () => {},
      onCopyFailed: () => {},
      now: () => 1000,
    })
    return { frames, controller, terminal, copied }
  }

  it("copies what a styled, erase-prefixed frame actually shows", async () => {
    const { frames, controller, copied } = wired()
    frames.stdout.write(
      `${ERASE}\x1b[1mCognia Agent\x1b[0m\n› tell me about \x1b[36msrc/app.ts\x1b[0m`
    )
    // Drag over "src/app.ts" on row 2 — display columns 16..25 (1-based 17..26).
    controller.handleMouse(press(2, 17))
    controller.handleMouse(drag(2, 26))
    controller.handleMouse(release(2, 26))
    await flush()
    expect(copied).toEqual(["src/app.ts"])
  })

  it("paints the highlight onto the terminal at the right row", () => {
    const { frames, controller, terminal } = wired("manual")
    frames.stdout.write(`${ERASE}first row\nsecond row`)
    terminal.length = 0
    controller.handleMouse(press(2, 1))
    controller.handleMouse(drag(2, 6))
    // Row 2 of the frame → terminal row 2, and the styled row is re-emitted with
    // reverse video over the dragged span.
    expect(terminal).toHaveLength(1)
    expect(terminal[0]).toContain("\x1b[2;1H")
    expect(terminal[0]).toContain("\x1b[7msecond\x1b[27m")
    // The erase prefix must NOT be replayed — it would rewind the cursor.
    expect(terminal[0]).not.toContain("\x1b[1A")
  })

  it("follows the content when Ink commits a different frame", async () => {
    const { frames, controller, copied } = wired("manual")
    frames.stdout.write(`${ERASE}alpha\nbravo`)
    controller.handleMouse(press(1, 1))
    controller.handleMouse(drag(1, 5))
    // The transcript scrolled: the same screen coordinates now hold other text,
    // and the copy reflects what is on screen NOW.
    frames.stdout.write(`${ERASE}delta\necho`)
    controller.copySelection()
    await flush()
    expect(copied).toEqual(["delta"])
  })
})
