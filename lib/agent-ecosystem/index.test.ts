import * as barrel from "./index"

it("re-exports the table, the lookups and the runtime link", () => {
  expect(barrel.AGENT_ECOSYSTEMS.length).toBeGreaterThan(0)
  expect(typeof barrel.findEcosystemByMigrationVendor).toBe("function")
  expect(typeof barrel.primaryPresetIdForMigrationVendor).toBe("function")
  expect(typeof barrel.isMigratable).toBe("function")
})
