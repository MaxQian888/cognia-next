import { POPUP_INITIAL_HEIGHT, POPUP_INITIAL_WIDTH } from "./popup-geometry"

describe("popup size estimate", () => {
  it("is a positive logical size", () => {
    expect(POPUP_INITIAL_WIDTH).toBeGreaterThan(0)
    expect(POPUP_INITIAL_HEIGHT).toBeGreaterThan(0)
  })

  it("is wide enough for the interaction panel card (18rem + padding)", () => {
    // The panel is `w-[min(18rem,…)]` (288px) inside a p-3 card plus the
    // shadow margin; a narrower estimate would visibly jump on first fit.
    expect(POPUP_INITIAL_WIDTH).toBeGreaterThanOrEqual(288 + 24 + 16)
  })
})
