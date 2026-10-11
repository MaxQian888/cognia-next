import { PIN_END, PIN_START, PIN_START_MAX_WIDTH } from "./perf-table-pin"

describe("perf-table-pin", () => {
  it("pins the name column to the start edge and the actions to the end edge", () => {
    expect(PIN_START).toContain("sticky")
    expect(PIN_START).toContain("left-0")
    expect(PIN_END).toContain("sticky")
    expect(PIN_END).toContain("right-0")
  })

  it("keeps a pinned cell opaque, hovering with its row", () => {
    for (const pin of [PIN_START, PIN_END]) {
      expect(pin).toContain("bg-background")
      expect(pin).toContain("[tr:hover>&]:")
    }
  })

  it("caps the pinned name column only on a phone", () => {
    expect(PIN_START_MAX_WIDTH).toBe("max-w-[45vw] sm:max-w-none")
  })
})
