import {
  POPUP_GAP_PX,
  POPUP_INITIAL_HEIGHT,
  POPUP_INITIAL_WIDTH,
  resolvePopupPlacement,
} from "./popup-geometry"

const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1080 }
const POPUP = { width: 320, height: 400 }

describe("resolvePopupPlacement", () => {
  it("centers horizontally over the sprite and sits above it when there's room", () => {
    // Sprite mid-screen with plenty of headroom above.
    const sprite = { x: 800, y: 600, width: 200, height: 200 }
    const { x, y } = resolvePopupPlacement(sprite, POPUP, WORK_AREA)
    // Centered: spriteCenterX 900 − popupHalf 160 = 740.
    expect(x).toBe(740)
    // Above: spriteTop 600 − gap − popupHeight.
    expect(y).toBe(600 - POPUP_GAP_PX - 400)
  })

  it("flips below the sprite when there isn't room above", () => {
    // Sprite near the top: above would cross the work-area top.
    const sprite = { x: 800, y: 40, width: 200, height: 200 }
    const { y } = resolvePopupPlacement(sprite, POPUP, WORK_AREA)
    // Below: spriteTop 40 + spriteHeight 200 + gap.
    expect(y).toBe(40 + 200 + POPUP_GAP_PX)
  })

  it("clamps X so the popup never leaves the left/right edges", () => {
    const atRight = { x: 1900, y: 600, width: 100, height: 100 }
    expect(resolvePopupPlacement(atRight, POPUP, WORK_AREA).x).toBe(1920 - 320)

    const atLeft = { x: -40, y: 600, width: 100, height: 100 }
    expect(resolvePopupPlacement(atLeft, POPUP, WORK_AREA).x).toBe(0)
  })

  it("clamps Y to the work area when neither side fully fits", () => {
    // Short monitor where even the flipped-below position would overflow.
    const shortArea = { x: 0, y: 0, width: 1920, height: 420 }
    const sprite = { x: 800, y: 30, width: 200, height: 200 }
    const { y } = resolvePopupPlacement(sprite, POPUP, shortArea)
    // Pinned to the lowest fully-visible top: areaHeight 420 − popupHeight 400.
    expect(y).toBe(20)
    expect(y).toBeGreaterThanOrEqual(0)
  })

  it("respects a work-area origin offset (taskbar / multi-monitor)", () => {
    const area = { x: 100, y: 50, width: 1000, height: 800 }
    const sprite = { x: 120, y: 700, width: 160, height: 160 }
    const { x, y } = resolvePopupPlacement(sprite, POPUP, area)
    // Centered then clamped into [100, 100+1000-320]; above the sprite top.
    expect(x).toBe(Math.max(100, 120 + 80 - 160))
    expect(y).toBe(700 - POPUP_GAP_PX - 400)
  })

  it("rounds to whole pixels", () => {
    const sprite = { x: 801, y: 605, width: 201, height: 201 }
    const { x, y } = resolvePopupPlacement(sprite, POPUP, WORK_AREA)
    expect(Number.isInteger(x)).toBe(true)
    expect(Number.isInteger(y)).toBe(true)
  })

  it("exposes sane initial window-size constants", () => {
    expect(POPUP_INITIAL_WIDTH).toBeGreaterThan(0)
    expect(POPUP_INITIAL_HEIGHT).toBeGreaterThan(0)
  })
})
