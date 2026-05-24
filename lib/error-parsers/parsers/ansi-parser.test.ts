/**
 * @jest-environment node
 */

import { ansiParser } from "./ansi-parser"

const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)

describe("ansiParser", () => {
  it("returns null when there is no ANSI escape", () => {
    expect(ansiParser.parse("plain error text")).toBeNull()
  })

  it("splits coloured runs into styled segments with escapes stripped", () => {
    const result = ansiParser.parse(`${ESC}[31mError${ESC}[0m here`)
    expect(result).not.toBeNull()
    expect(result!.parsed).toBe(true)
    const node = result!.nodes[0]
    expect(node.kind).toBe("ansi")
    expect(node.content).toBe("Error here")
    expect(node.segments).toEqual([
      { text: "Error", className: "text-red-500" },
      { text: " here", className: undefined },
    ])
  })

  it("combines colour + bold into one className", () => {
    const result = ansiParser.parse(`${ESC}[1;32mOK${ESC}[0m`)
    expect(result!.nodes[0].segments).toEqual([
      { text: "OK", className: "text-green-500 font-bold" },
    ])
  })

  it("skips 256-colour operands so the index is not misread as a standard code", () => {
    // 38;5;31 selects 256-colour index 31 — must NOT turn the run red.
    const result = ansiParser.parse(`${ESC}[38;5;31mX${ESC}[0m`)
    expect(result!.nodes[0].segments).toEqual([{ text: "X", className: undefined }])
  })

  it("strips non-SGR CSI sequences (cursor / erase) without styling", () => {
    const result = ansiParser.parse(`${ESC}[2K${ESC}[31mhi${ESC}[0m`)
    expect(result!.nodes[0].content).toBe("hi")
    expect(result!.nodes[0].segments).toEqual([{ text: "hi", className: "text-red-500" }])
  })

  it("strips OSC sequences (window title)", () => {
    const result = ansiParser.parse(`${ESC}]0;my title${BEL}${ESC}[32mdone${ESC}[0m`)
    expect(result!.nodes[0].content).toBe("done")
  })
})
