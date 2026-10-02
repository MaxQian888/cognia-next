import * as contract from "./contract"
import * as derive from "./derive"
import * as publicStatus from "./public-status"
import { sortIncidentUpdatesNewestFirst } from "./public-status"

describe("public-status barrel", () => {
  it("re-exports the contract and derivation without preview helpers", () => {
    expect(publicStatus.STATUS_SCHEMA_VERSION).toBe(contract.STATUS_SCHEMA_VERSION)
    expect(publicStatus.deriveOverallStatus).toBe(derive.deriveOverallStatus)
    expect(typeof publicStatus.parsePublicSnapshot).toBe("function")
    expect(typeof publicStatus.resolveStatusRuntime).toBe("function")
    expect("createPreviewStatusSnapshot" in publicStatus).toBe(false)
    expect("calculateUptime" in publicStatus).toBe(false)
  })

  it("orders incident updates newest first without mutating the source", () => {
    const updates = [
      { id: "a", at: "2026-08-11T07:58:00.000Z" },
      { id: "c", at: "2026-08-11T08:31:00.000Z" },
      { id: "b", at: "2026-08-11T08:16:00.000Z" },
    ]
    expect(sortIncidentUpdatesNewestFirst(updates).map((update) => update.id)).toEqual([
      "c",
      "b",
      "a",
    ])
    expect(updates[0].id).toBe("a")
  })
})
