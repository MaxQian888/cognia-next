/**
 * @jest-environment node
 */
import {
  LAUNCH_BANNER_ROWS,
  LAUNCH_LIST_CHROME_ROWS,
  LAUNCH_MIN_BODY_ROWS,
  launchListRows,
  launchShellLayout,
} from "./launch-shell-layout"

describe("launchShellLayout", () => {
  it("keeps banner, body and hint on a roomy terminal", () => {
    expect(launchShellLayout(40, true)).toEqual({
      showBanner: true,
      bodyRows: 40 - LAUNCH_BANNER_ROWS - 1,
      showHint: true,
    })
  })

  it("drops the BANNER first when rows get tight — the body is what matters", () => {
    // 12 rows: banner (7) + hint (1) would leave 4 for the body… which still
    // fits, so the interesting cut is one row lower.
    const tight = launchShellLayout(10, true)
    expect(tight.showBanner).toBe(false)
    expect(tight.showHint).toBe(true)
    expect(tight.bodyRows).toBe(9)
  })

  it("gives the body every row once the banner is gone", () => {
    expect(launchShellLayout(8, false)).toEqual({
      showBanner: false,
      bodyRows: 8,
      showHint: false,
    })
  })

  it("drops the hint only when the body would otherwise fall below its floor", () => {
    const cramped = launchShellLayout(3, true)
    expect(cramped).toEqual({ showBanner: false, bodyRows: 3, showHint: false })
  })

  it("never reports a body below the usable floor, even at zero rows", () => {
    expect(launchShellLayout(0, true).bodyRows).toBe(LAUNCH_MIN_BODY_ROWS)
    expect(launchShellLayout(-5, true).bodyRows).toBe(LAUNCH_MIN_BODY_ROWS)
  })

  it("reserves nothing for a hint that is not there", () => {
    const withHint = launchShellLayout(20, true)
    const without = launchShellLayout(20, false)
    expect(without.bodyRows).toBe(withHint.bodyRows + 1)
  })

  it.each([
    [12, 40],
    [16, 60],
    [24, 80],
    [40, 120],
  ])("keeps a usable body at %ix%i", (rows) => {
    const layout = launchShellLayout(rows, true)
    expect(layout.bodyRows).toBeGreaterThanOrEqual(LAUNCH_MIN_BODY_ROWS)
    // The frame must never claim more rows than the terminal has.
    const used =
      layout.bodyRows + (layout.showBanner ? LAUNCH_BANNER_ROWS : 0) + (layout.showHint ? 1 : 0)
    expect(used).toBeLessThanOrEqual(rows)
  })
})

describe("launchListRows", () => {
  it("hands the list whatever the body has left after its chrome", () => {
    expect(launchListRows(20, LAUNCH_LIST_CHROME_ROWS)).toBe(15)
  })

  it("always offers at least one row, so a picker is never empty", () => {
    expect(launchListRows(2, LAUNCH_LIST_CHROME_ROWS)).toBe(1)
    expect(launchListRows(0, LAUNCH_LIST_CHROME_ROWS)).toBe(1)
  })
})
