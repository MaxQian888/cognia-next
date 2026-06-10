import { cyclePermissionMode } from "./mode-cycle"
import { PERMISSION_MODES } from "../../config/schema"
import type { PermissionMode } from "../state/types"

describe("cyclePermissionMode", () => {
  it("advances to the next mode", () => {
    expect(cyclePermissionMode("default")).toBe("acceptEdits")
    expect(cyclePermissionMode("acceptEdits")).toBe("bypassPermissions")
    expect(cyclePermissionMode("bypassPermissions")).toBe("plan")
  })

  it("wraps from the last mode back to the first", () => {
    expect(cyclePermissionMode("plan")).toBe(PERMISSION_MODES[0])
  })

  it("visits every mode exactly once over a full cycle", () => {
    const seen: string[] = []
    let mode: PermissionMode = PERMISSION_MODES[0]
    for (let i = 0; i < PERMISSION_MODES.length; i++) {
      seen.push(mode)
      mode = cyclePermissionMode(mode)
    }
    expect(new Set(seen).size).toBe(PERMISSION_MODES.length)
    expect(mode).toBe(PERMISSION_MODES[0])
  })

  it("falls back to the first mode for an unknown current", () => {
    expect(cyclePermissionMode("bogus" as never)).toBe(PERMISSION_MODES[0])
  })
})
