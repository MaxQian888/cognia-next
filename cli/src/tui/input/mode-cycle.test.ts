import { cyclePermissionMode } from "./mode-cycle"
import { SAFE_CYCLE_MODES } from "../state/permission-mode-meta"
import type { PermissionMode } from "../state/types"

describe("cyclePermissionMode", () => {
  it("advances through the safe core only", () => {
    expect(cyclePermissionMode("default")).toBe("acceptEdits")
    expect(cyclePermissionMode("acceptEdits")).toBe("plan")
  })

  it("wraps from the last safe mode back to the first", () => {
    expect(cyclePermissionMode("plan")).toBe(SAFE_CYCLE_MODES[0])
  })

  it("never cycles into a power mode", () => {
    let mode: PermissionMode = SAFE_CYCLE_MODES[0]
    const seen = new Set<string>()
    for (let i = 0; i < 10; i++) {
      mode = cyclePermissionMode(mode)
      seen.add(mode)
    }
    expect(seen).toEqual(new Set(SAFE_CYCLE_MODES))
    expect(seen.has("bypassPermissions")).toBe(false)
    expect(seen.has("dontAsk")).toBe(false)
    expect(seen.has("auto")).toBe(false)
  })

  it("visits every safe mode exactly once over a full cycle", () => {
    const seen: string[] = []
    let mode: PermissionMode = SAFE_CYCLE_MODES[0]
    for (let i = 0; i < SAFE_CYCLE_MODES.length; i++) {
      seen.push(mode)
      mode = cyclePermissionMode(mode)
    }
    expect(new Set(seen).size).toBe(SAFE_CYCLE_MODES.length)
    expect(mode).toBe(SAFE_CYCLE_MODES[0])
  })

  it("de-escalates a power mode back to the first safe mode", () => {
    expect(cyclePermissionMode("bypassPermissions")).toBe(SAFE_CYCLE_MODES[0])
    expect(cyclePermissionMode("dontAsk")).toBe(SAFE_CYCLE_MODES[0])
    expect(cyclePermissionMode("auto")).toBe(SAFE_CYCLE_MODES[0])
  })

  it("falls back to the first safe mode for an unknown current", () => {
    expect(cyclePermissionMode("bogus" as never)).toBe(SAFE_CYCLE_MODES[0])
  })
})
