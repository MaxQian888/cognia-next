import { isResolvableByPluginTransfer, MIGRATION_BLOCKER_KINDS } from "./types"

describe("migration blockers", () => {
  it("lists every kind once", () => {
    expect(new Set(MIGRATION_BLOCKER_KINDS).size).toBe(MIGRATION_BLOCKER_KINDS.length)
    expect(MIGRATION_BLOCKER_KINDS[0]).toBe("host-unreachable")
  })

  it("offers plugin transfer only for a missing or mismatched plugin", () => {
    expect(
      isResolvableByPluginTransfer({ kind: "plugin-missing", pluginId: "p", version: "1" })
    ).toBe(true)
    expect(
      isResolvableByPluginTransfer({
        kind: "plugin-version-mismatch",
        pluginId: "p",
        version: "2",
        hostVersion: "1",
      })
    ).toBe(true)
    expect(isResolvableByPluginTransfer({ kind: "host-too-old" })).toBe(false)
    expect(
      isResolvableByPluginTransfer({ kind: "reference-missing", reference: "workflow", id: "w" })
    ).toBe(false)
  })
})
