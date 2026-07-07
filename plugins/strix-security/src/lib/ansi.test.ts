import { stripAnsi } from "./ansi"

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

describe("stripAnsi", () => {
  it("removes SGR color codes", () => {
    expect(stripAnsi(`${ESC}[31mred${ESC}[0m`)).toBe("red")
    expect(stripAnsi(`${ESC}[1;33mbold yellow${ESC}[0m done`)).toBe("bold yellow done")
  })

  it("removes cursor-movement CSI sequences", () => {
    expect(stripAnsi(`a${ESC}[2Kb${ESC}[1Gc`)).toBe("abc")
  })

  it("removes OSC hyperlinks (BEL- and ST-terminated)", () => {
    expect(stripAnsi(`${ESC}]8;;https://x${BEL}link${ESC}]8;;${BEL}`)).toBe("link")
    expect(stripAnsi(`${ESC}]0;title${ESC}\\rest`)).toBe("rest")
  })

  it("leaves plain text untouched", () => {
    expect(stripAnsi("no escapes here\nsecond line")).toBe("no escapes here\nsecond line")
  })
})
