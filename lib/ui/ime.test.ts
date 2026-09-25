/** @jest-environment jsdom */

import { IME_PROCESS_KEY_CODE, isImeComposing } from "./ime"

describe("isImeComposing", () => {
  it("is false for a plain Enter", () => {
    expect(isImeComposing({ nativeEvent: { isComposing: false, keyCode: 13 }, keyCode: 13 })).toBe(
      false
    )
    expect(isImeComposing({ isComposing: false, keyCode: 13 })).toBe(false)
  })

  it("reads isComposing from a React event's native event", () => {
    expect(isImeComposing({ nativeEvent: { isComposing: true }, keyCode: 13 })).toBe(true)
  })

  it("reads isComposing from a DOM KeyboardEvent", () => {
    expect(isImeComposing({ isComposing: true })).toBe(true)
  })

  // WebKit: the confirming Enter arrives after compositionend, isComposing
  // false, keyCode 229.
  it("treats WebKit's post-composition keyCode 229 as composing", () => {
    expect(
      isImeComposing({
        nativeEvent: { isComposing: false, keyCode: IME_PROCESS_KEY_CODE },
        keyCode: IME_PROCESS_KEY_CODE,
      })
    ).toBe(true)
    expect(isImeComposing({ isComposing: false, keyCode: IME_PROCESS_KEY_CODE })).toBe(true)
  })

  it("works on a real DOM KeyboardEvent", () => {
    expect(isImeComposing(new KeyboardEvent("keydown", { key: "Enter", isComposing: true }))).toBe(
      true
    )
    expect(isImeComposing(new KeyboardEvent("keydown", { key: "Enter" }))).toBe(false)
  })
})
