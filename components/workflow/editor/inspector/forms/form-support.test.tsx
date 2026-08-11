import { clampNumberInput, parseArrayJson, parseObjectJson } from "./form-support"

describe("workflow form support", () => {
  it("normalizes shared JSON and number inputs", () => {
    expect(parseObjectJson('{"ok":true}')).toEqual({ ok: true })
    expect(parseArrayJson("[1,2]")).toEqual([1, 2])
    expect(clampNumberInput("99", 0, 10, 5)).toBe(10)
  })
})
