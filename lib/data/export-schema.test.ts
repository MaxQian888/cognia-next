import * as exportSchema from "./export-schema"

describe("export-schema barrel", () => {
  it("re-exports EXPORT_SCHEMA_VERSION", () => {
    expect(exportSchema.EXPORT_SCHEMA_VERSION).toBe(3)
  })

  it("re-exports the error classes", () => {
    expect(typeof exportSchema.IsEncryptedError).toBe("function")
    expect(typeof exportSchema.UnsupportedSchemaVersionError).toBe("function")
    expect(typeof exportSchema.IntegrityCheckFailedError).toBe("function")
  })

  it("re-exports emptySummary as a function", () => {
    expect(typeof exportSchema.emptySummary).toBe("function")
    expect(exportSchema.emptySummary()).toEqual({
      added: {},
      overwritten: {},
      skipped: {},
      builtInsSkipped: {},
    })
  })
})
