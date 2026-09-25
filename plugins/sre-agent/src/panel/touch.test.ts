import { TOUCH_BUTTON, TOUCH_ICON_BUTTON } from "./touch"

it("keeps every control at least 36px (h-9 / size-9) below the sm breakpoint", () => {
  expect(TOUCH_BUTTON.split(" ")).toContain("h-9")
  expect(TOUCH_ICON_BUTTON.split(" ")).toContain("size-9")
  // Compact sizes only apply from `sm` up.
  for (const token of [...TOUCH_BUTTON.split(" "), ...TOUCH_ICON_BUTTON.split(" ")]) {
    if (/^(h|size)-[0-8]$/.test(token)) throw new Error(`${token} applies at every width`)
  }
})
