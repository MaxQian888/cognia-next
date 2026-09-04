/** @jest-environment node */
import { TerminalScreen } from "./terminal-screen"

const ESC = "\u001b"
const csi = (body: string) => `${ESC}[${body}`

const screen = (columns = 20, rows = 6) => new TerminalScreen({ columns, rows })

describe("TerminalScreen", () => {
  it("shows what is on screen, not everything ever printed", () => {
    // The whole point. A stripped byte stream still contains "stale", so an
    // assertion against it passes long after the app erased the row.
    const s = screen()
    s.write("stale")
    s.write(`${csi("2J")}${csi("H")}fresh`)
    expect(s.text()).toBe("fresh")
    expect(s.text()).not.toContain("stale")
  })

  it("overwrites in place when the cursor is moved back", () => {
    const s = screen()
    s.write(`abcdef${csi("1;1H")}XY`)
    expect(s.text()).toBe("XYcdef")
  })

  it("erases to the end of a line", () => {
    const s = screen()
    s.write(`abcdef${csi("1;3H")}${csi("K")}`)
    expect(s.text()).toBe("ab")
  })

  it("erases from the cursor down", () => {
    const s = screen()
    s.write("one\r\ntwo\r\nthree")
    s.write(`${csi("2;1H")}${csi("J")}`)
    expect(s.lines()).toEqual(["one"])
  })

  it("wraps a run past the right edge onto the next row", () => {
    const s = screen(5, 4)
    s.write("abcdefgh")
    expect(s.lines()).toEqual(["abcde", "fgh"])
  })

  it("gives a wide glyph both of its cells", () => {
    const s = screen(6, 2)
    s.write("模型ab")
    expect(s.lines()).toEqual(["模型ab"])
    expect(s.cursor.column).toBe(6)
  })

  // A pty puts the tty in ONLCR, so an app's "\n" reaches the master as "\r\n".
  // A bare line feed moves down WITHOUT returning to column 0, and treating it
  // as a newline would quietly hide a real column bug in the app under test.
  it("moves down without a carriage return on a bare line feed", () => {
    const s = screen(10, 3)
    s.write("ab\ncd")
    expect(s.lines()).toEqual(["ab", "  cd"])
  })

  it("scrolls when a line feed runs off the last row", () => {
    const s = screen(10, 2)
    s.write("one\r\ntwo\r\nthree")
    expect(s.lines()).toEqual(["two", "three"])
  })

  it("buffers a control sequence split across two reads", () => {
    const s = screen()
    s.write(`abc${ESC}`)
    s.write(`[1;1Hz`)
    expect(s.text()).toBe("zbc")
  })

  it("drops an OSC payload but keeps the hyperlink label between the two", () => {
    const s = screen(40, 2)
    s.write(`${ESC}]8;;http://x.test\u0007Home${ESC}]8;;\u0007`)
    expect(s.text()).toBe("Home")
  })

  it("tracks the modes a terminal has to be left in", () => {
    const s = screen()
    s.write(`${csi("?1049h")}${csi("?25l")}${csi("?1000h")}${csi("?1006h")}`)
    expect(s.altScreen).toBe(true)
    expect(s.cursorVisible).toBe(false)
    expect([...s.mouseModes].sort()).toEqual(["1000", "1006"])
    s.write(`${csi("?1006l")}${csi("?1000l")}${csi("?25h")}${csi("?1049l")}`)
    expect(s.altScreen).toBe(false)
    expect(s.cursorVisible).toBe(true)
    expect(s.mouseModes.size).toBe(0)
  })

  it("ignores appearance-only sequences", () => {
    const s = screen()
    s.write(`${csi("1m")}${csi("38;2;1;2;3m")}bold${csi("0m")}`)
    expect(s.text()).toBe("bold")
  })

  it("repaints from empty after a resize", () => {
    const s = screen()
    s.write("before")
    s.resize(10, 3)
    expect(s.text()).toBe("")
    expect(s.columns).toBe(10)
    s.write("after")
    expect(s.text()).toBe("after")
  })

  it("collapses wrapped text so a phrase still reads as one", () => {
    const s = screen(6, 4)
    s.write("hello there")
    expect(s.lines().length).toBeGreaterThan(1)
    expect(s.flatText()).toBe("hello there")
  })
})
