/** @jest-environment node */
import { ansiToSpans, xterm256Color } from "./ansi-spans"

const E = String.fromCharCode(27)
const sgr = (params: string) => `${E}[${params}m`

describe("xterm256Color", () => {
  it("maps the base 16, the colour cube and the grey ramp", () => {
    expect(xterm256Color(1)).toBe("red")
    expect(xterm256Color(9)).toBe("redBright")
    // Cube index 16 is the black corner, 231 the white one.
    expect(xterm256Color(16)).toBe("#000000")
    expect(xterm256Color(231)).toBe("#ffffff")
    // 196 is pure red in the cube (5, 0, 0).
    expect(xterm256Color(196)).toBe("#ff0000")
    // The grey ramp starts at 8 and steps by 10.
    expect(xterm256Color(232)).toBe("#080808")
    expect(xterm256Color(255)).toBe("#eeeeee")
    expect(xterm256Color(-1)).toBeUndefined()
    expect(xterm256Color(256)).toBeUndefined()
  })
})

describe("ansiToSpans", () => {
  it("splits a coloured run out of its surrounding text", () => {
    expect(ansiToSpans(`plain ${sgr("34")}blue${sgr("39")} plain`, "muted")).toEqual([
      { text: "plain ", style: "muted" },
      { text: "blue", style: "muted", color: "blue" },
      { text: " plain", style: "muted" },
    ])
  })

  it("reads truecolour and 256-colour foregrounds", () => {
    expect(ansiToSpans(`${sgr("38;2;18;52;86")}rgb`)).toEqual([
      { text: "rgb", style: "plain", color: "#123456" },
    ])
    expect(ansiToSpans(`${sgr("38;5;196")}idx`)).toEqual([
      { text: "idx", style: "plain", color: "#ff0000" },
    ])
  })

  it("carries and clears the text attributes", () => {
    expect(ansiToSpans(`${sgr("1")}${sgr("4")}loud${sgr("24")}quiet${sgr("0")}off`)).toEqual([
      { text: "loud", style: "plain", bold: true, underline: true },
      { text: "quiet", style: "plain", bold: true },
      { text: "off", style: "plain" },
    ])
  })

  it("treats a bare reset sequence as a full reset", () => {
    expect(ansiToSpans(`${sgr("31")}red${sgr("")}after`)).toEqual([
      { text: "red", style: "plain", color: "red" },
      { text: "after", style: "plain" },
    ])
  })

  it("emits escape-free text, so the block builder measures real cells", () => {
    const spans = ansiToSpans(`${sgr("32")}ok${sgr("39")}`)
    expect(spans.map((s) => s.text).join("")).toBe("ok")
    expect(JSON.stringify(spans)).not.toContain(E)
  })

  it("returns nothing for empty input", () => {
    expect(ansiToSpans("")).toEqual([])
  })
})
