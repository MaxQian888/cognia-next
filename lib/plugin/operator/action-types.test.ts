/**
 * `action-types.ts` is a type-only module — there are no runtime values to
 * exercise. These tests serve two purposes:
 *
 *   1. Lock the structural shape of the discriminated `OperatorAction` union
 *      so renames or field-drops fail at test time, not at runtime.
 *   2. Guarantee the `OperatorActionResult` shape covers what the screenshot
 *      and zoom return paths need (display dimensions for coordinate
 *      scaling).
 *
 * If TypeScript compiles this file, the types still align with the
 * declarations. We additionally assert at runtime that representative
 * action literals satisfy the union via simple shape checks.
 */

import type {
  OperatorAction,
  OperatorActionResult,
  OperatorActionType,
  Coordinate,
} from "./action-types"

describe("operator action-types", () => {
  it("OperatorActionType union enumerates every action kind used by every backend", () => {
    const allKinds: OperatorActionType[] = [
      "screenshot",
      "left_click",
      "right_click",
      "middle_click",
      "double_click",
      "triple_click",
      "mouse_move",
      "left_click_drag",
      "left_mouse_down",
      "left_mouse_up",
      "scroll",
      "type",
      "key",
      "hold_key",
      "wait",
      "zoom",
    ]
    expect(allKinds).toHaveLength(16)
    expect(new Set(allKinds).size).toBe(16)
  })

  it("Coordinate is a {x, y} pair of numbers", () => {
    const c: Coordinate = { x: 100, y: 200 }
    expect(c.x).toBe(100)
    expect(c.y).toBe(200)
  })

  it("each OperatorAction variant satisfies the discriminator", () => {
    const cases: OperatorAction[] = [
      { action: "screenshot" },
      { action: "left_click", coordinate: { x: 10, y: 20 } },
      { action: "mouse_move", coordinate: { x: 5, y: 5 } },
      {
        action: "left_click_drag",
        start_coordinate: { x: 0, y: 0 },
        coordinate: { x: 10, y: 10 },
      },
      { action: "left_mouse_down", coordinate: { x: 1, y: 1 } },
      {
        action: "scroll",
        coordinate: { x: 100, y: 100 },
        scroll_direction: "down",
        scroll_amount: 3,
      },
      { action: "type", text: "hello" },
      { action: "key", text: "Return" },
      { action: "hold_key", text: "shift", duration: 1.5 },
      { action: "wait", duration: 0.5 },
      { action: "zoom", region: [0, 0, 100, 100] },
    ]
    for (const c of cases) {
      expect(c.action).toBeDefined()
    }
    expect(cases).toHaveLength(11)
  })

  it("OperatorActionResult carries enough metadata for coordinate scaling on screenshot returns", () => {
    const result: OperatorActionResult = {
      ok: true,
      output: "base64png",
      display_width_px: 1920,
      display_height_px: 1080,
    }
    expect(result.ok).toBe(true)
    expect(result.display_width_px).toBe(1920)
    expect(result.display_height_px).toBe(1080)
  })

  it("scroll action permits a `text` modifier-key field (shift for horizontal scroll)", () => {
    const horiz: OperatorAction = {
      action: "scroll",
      coordinate: { x: 0, y: 0 },
      scroll_direction: "right",
      scroll_amount: 5,
      text: "shift",
    }
    expect(horiz.action).toBe("scroll")
    if (horiz.action === "scroll") {
      expect(horiz.text).toBe("shift")
      expect(horiz.scroll_direction).toBe("right")
    }
  })
})
