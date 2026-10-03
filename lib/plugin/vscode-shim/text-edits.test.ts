import { applyTextEdits } from "./text-edits"

const at = (line: number, character: number) => ({ line, character })
const edit = (sl: number, sc: number, el: number, ec: number, newText: string) => ({
  range: { start: at(sl, sc), end: at(el, ec) },
  newText,
})

describe("applyTextEdits", () => {
  it("applies every edit against the original text", () => {
    expect(
      applyTextEdits("hello\nworld", [
        edit(1, 0, 1, 5, "there"),
        edit(0, 0, 0, 0, ">"),
        edit(0, 5, 1, 0, " "),
      ])
    ).toBe(">hello there")
  })

  it("counts CRLF and CR as one line break, and clamps positions like VS Code", () => {
    expect(applyTextEdits("ab\r\ncd\ref", [edit(1, 1, 1, 99, "X"), edit(2, 0, 9, 9, "!")])).toBe(
      "ab\r\ncX\r!"
    )
    expect(applyTextEdits("ab", [edit(-1, 0, 0, 1, "Z")])).toBe("Zb")
  })

  it("keeps inserts at one place in the order given", () => {
    expect(applyTextEdits("x", [edit(0, 0, 0, 0, "a"), edit(0, 0, 0, 0, "b")])).toBe("abx")
  })

  it("refuses overlapping edits", () => {
    expect(() => applyTextEdits("abcdef", [edit(0, 0, 0, 3, "x"), edit(0, 2, 0, 4, "y")])).toThrow(
      /Overlapping/
    )
  })

  it("rewrites line breaks when asked", () => {
    expect(applyTextEdits("a\r\nb\nc", [], 1)).toBe("a\nb\nc")
    expect(applyTextEdits("a\nb\r\nc", [], 2)).toBe("a\r\nb\r\nc")
  })
})
