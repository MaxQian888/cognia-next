/**
 * The fleet DTOs are compile-time types; the only runtime surface is the two
 * constants below, which must stay in lockstep with the Rust side
 * (`src-tauri/src/fleet/mod.rs`) — assert their literal values so a drift is a
 * failing test, not a silent no-op event subscription.
 */

import { FLEET_PERMISSION_WAIT_MS, FLEET_UPDATE_EVENT } from "./types"

describe("fleet runtime constants", () => {
  it("pins the update event topic to the Rust UPDATE_EVENT", () => {
    expect(FLEET_UPDATE_EVENT).toBe("fleet://update")
  })

  it("keeps the island answer window below the curl/hook timeout ladder", () => {
    // 20s island < 25s curl --max-time < 30s settings.json hook timeout.
    expect(FLEET_PERMISSION_WAIT_MS).toBe(20_000)
    expect(FLEET_PERMISSION_WAIT_MS).toBeLessThan(25_000)
  })
})
