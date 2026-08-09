import { applyMigration, buildMigrationPreview, MIGRATION_ARTIFACTS, probeVendors } from "./index"

describe("agent-migration public API", () => {
  it("exports the migration orchestration surface", () => {
    expect(MIGRATION_ARTIFACTS).toContain("sessions")
    expect(applyMigration).toEqual(expect.any(Function))
    expect(buildMigrationPreview).toEqual(expect.any(Function))
    expect(probeVendors).toEqual(expect.any(Function))
  })
})
