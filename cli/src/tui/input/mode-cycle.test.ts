import { cyclePermissionMode } from "./mode-cycle"
import { ADVANCED_MODES, CYCLE_MODES, SAFE_CYCLE_MODES } from "../state/permission-mode-meta"
import type { PermissionMode } from "../state/types"

describe("cyclePermissionMode", () => {
  it("advances through the safe core, then lands on bypass", () => {
    expect(cyclePermissionMode("default")).toBe("acceptEdits")
    expect(cyclePermissionMode("acceptEdits")).toBe("plan")
    expect(cyclePermissionMode("plan")).toBe("bypassPermissions")
  })

  it("wraps from the last cycled mode back to the first", () => {
    expect(cyclePermissionMode("bypassPermissions")).toBe(CYCLE_MODES[0])
  })

  it("never cycles into an off-cycle power mode", () => {
    let mode: PermissionMode = CYCLE_MODES[0]
    const seen = new Set<string>()
    for (let i = 0; i < 10; i++) {
      mode = cyclePermissionMode(mode)
      seen.add(mode)
    }
    expect(seen).toEqual(new Set(CYCLE_MODES))
    expect(seen.has("dontAsk")).toBe(false)
    expect(seen.has("auto")).toBe(false)
  })

  it("visits every cycled mode exactly once over a full cycle", () => {
    const seen: string[] = []
    let mode: PermissionMode = CYCLE_MODES[0]
    for (let i = 0; i < CYCLE_MODES.length; i++) {
      seen.push(mode)
      mode = cyclePermissionMode(mode)
    }
    expect(new Set(seen).size).toBe(CYCLE_MODES.length)
    expect(mode).toBe(CYCLE_MODES[0])
  })

  it("de-escalates an off-cycle power mode back to the first safe mode", () => {
    for (const mode of ADVANCED_MODES) {
      expect(cyclePermissionMode(mode)).toBe(SAFE_CYCLE_MODES[0])
    }
  })

  it("falls back to the first safe mode for an unknown current", () => {
    expect(cyclePermissionMode("bogus" as never)).toBe(SAFE_CYCLE_MODES[0])
  })
})
